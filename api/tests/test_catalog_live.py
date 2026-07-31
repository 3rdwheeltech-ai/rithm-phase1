"""
The atomic completion path, against real Postgres.

Everything else in this suite runs on FakeSession, which is right for SQL built
from module constants. Three things cannot be faked, and all three are what
Gate C actually leans on:

  * the cross-schema **grant** — rithm_generation writing catalog.tracks. The
    code under test connects as that role precisely so a missing
    0002_catalog_generation_grants fails here rather than in prod.
  * the **unique index** backing ON CONFLICT (source_job_id), without which the
    replay backstop raises instead of no-op'ing.
  * the **transaction** itself — that a failure after the job UPDATE leaves the
    job non-terminal and no track behind.

Two connections, and the split is deliberate: `live_session` is the generation
role (INSERT on catalog and nothing else), `admin_session` is an owner used only
for setup, verification reads and teardown. Needing the second one is itself
evidence the grant is as narrow as intended.

Skipped unless RITHM_TEST_DB_DSN and RITHM_TEST_DB_ADMIN_DSN are set; see
tests/conftest.py for setup.
"""
import json
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid_utils import uuid7

from app.modules.catalog.service import CatalogService
from app.modules.generation.interfaces import CreatedTrack
from app.modules.generation.service import GenerationService
from app.modules.generation.sse_hub import SSEHub
from tests.conftest import requires_live_db

pytestmark = [requires_live_db, pytest.mark.asyncio]

_PARAMS: dict[str, Any] = {
    "prompt": "a warm lo-fi loop",
    "genre": "Lo-Fi",
    "mood": "Calm",
    "bpm": 90,
    "instruments": [],
    "vocal": False,
    "length_seconds": 30,
    "seed": None,
}

_WAV_KEY = "tracks/u/j/master.wav"
_MP3_KEY = "tracks/u/j/audio.mp3"


def _uuid() -> UUID:
    return UUID(str(uuid7()))


@pytest_asyncio.fixture
async def job_ids(
    admin_session: AsyncSession,
) -> AsyncIterator[dict[str, UUID]]:
    """A real QUEUED job to finalize, torn down afterwards."""
    ids = {"job": _uuid(), "user": _uuid()}
    await admin_session.execute(
        text(
            """
            INSERT INTO generation.jobs
                (id, user_id, kind, status, request_payload, created_at)
            VALUES (:id, :user_id, 'generate', 'QUEUED',
                    CAST(:payload AS JSONB), now())
            """
        ),
        {
            "id": str(ids["job"]),
            "user_id": str(ids["user"]),
            "payload": json.dumps(_PARAMS),
        },
    )
    await admin_session.commit()

    yield ids

    # Cleanup runs as admin: the generation role has INSERT on catalog and
    # nothing else, so it cannot delete what it just wrote. Tracks first —
    # prompt_history cascades from tracks, and the tracks→jobs link is logical,
    # not an FK.
    await admin_session.execute(
        text("DELETE FROM catalog.tracks WHERE source_job_id = :jid"),
        {"jid": str(ids["job"])},
    )
    await admin_session.execute(
        text("DELETE FROM generation.jobs WHERE id = :jid"),
        {"jid": str(ids["job"])},
    )
    await admin_session.commit()


async def _count_tracks(admin: AsyncSession, job_id: UUID) -> int:
    result = await admin.execute(
        text("SELECT count(*) FROM catalog.tracks WHERE source_job_id = :jid"),
        {"jid": str(job_id)},
    )
    return int(result.scalar_one())


async def _count_prompts(admin: AsyncSession, job_id: UUID) -> int:
    result = await admin.execute(
        text(
            """
            SELECT count(*) FROM catalog.prompt_history ph
              JOIN catalog.tracks t ON t.id = ph.track_id
             WHERE t.source_job_id = :jid
            """
        ),
        {"jid": str(job_id)},
    )
    return int(result.scalar_one())


async def _job_status(admin: AsyncSession, job_id: UUID) -> str:
    result = await admin.execute(
        text("SELECT status FROM generation.jobs WHERE id = :jid"),
        {"jid": str(job_id)},
    )
    return str(result.scalar_one())


async def _write_track(session: AsyncSession, ids: dict[str, UUID]) -> Any:
    return await CatalogService().create_track_in_txn(
        session,
        user_id=ids["user"],
        source_job_id=ids["job"],
        kind="generate",
        prompt=str(_PARAMS["prompt"]),
        params=_PARAMS,
        s3_wav_key=_WAV_KEY,
        s3_mp3_key=_MP3_KEY,
        waveform_hash="a" * 64,
    )


# ── create_track_in_txn, as the generation role ────────────────


async def test_generation_role_can_write_a_track_and_its_prompt(
    live_session: AsyncSession,
    admin_session: AsyncSession,
    job_ids: dict[str, UUID],
) -> None:
    """
    Also the grant test: this INSERT is executed by rithm_generation, so it
    fails with "permission denied for schema catalog" if the migration is
    missing.
    """
    created = await _write_track(live_session, job_ids)
    await live_session.commit()

    assert await _count_tracks(admin_session, job_ids["job"]) == 1
    assert await _count_prompts(admin_session, job_ids["job"]) == 1

    row = (
        await admin_session.execute(
            text(
                """
                SELECT genre, mood, bpm, vocal, length_seconds, prompt,
                       params, s3_wav_key, s3_mp3_key, waveform_hash
                  FROM catalog.tracks WHERE source_job_id = :jid
                """
            ),
            {"jid": str(job_ids["job"])},
        )
    ).mappings().one()

    assert row["genre"] == "Lo-Fi"
    assert row["mood"] == "Calm"
    assert row["bpm"] == 90
    assert row["vocal"] is False
    assert row["length_seconds"] == 30
    assert row["prompt"] == _PARAMS["prompt"]
    assert row["params"] == _PARAMS          # round-tripped through JSONB
    assert row["s3_wav_key"] == _WAV_KEY
    assert row["waveform_hash"].strip() == "a" * 64
    assert created["mp3_key"] == _MP3_KEY

    kind = (
        await admin_session.execute(
            text(
                """
                SELECT ph.kind FROM catalog.prompt_history ph
                  JOIN catalog.tracks t ON t.id = ph.track_id
                 WHERE t.source_job_id = :jid
                """
            ),
            {"jid": str(job_ids["job"])},
        )
    ).scalar_one()
    assert kind == "initial"


async def test_replayed_source_job_id_still_yields_one_track(
    live_session: AsyncSession,
    admin_session: AsyncSession,
    job_ids: dict[str, UUID],
) -> None:
    """
    The ON CONFLICT backstop, which needs the unique index the migration adds.
    Without that index the second insert raises instead of no-op'ing.
    """
    for _ in range(2):
        await _write_track(live_session, job_ids)
        await live_session.commit()

    assert await _count_tracks(admin_session, job_ids["job"]) == 1
    assert await _count_prompts(admin_session, job_ids["job"]) == 1


async def test_grant_does_not_expose_track_content(
    live_session: AsyncSession, job_ids: dict[str, UUID]
) -> None:
    """
    The grant's narrowness is a feature, so pin it.

    generation holds column-level SELECT on source_job_id — required for the
    ON CONFLICT arbiter probe — and nothing else. Reading any other column must
    still be denied. If this starts passing, someone replaced the column grant
    with a table-level one and generation can now read every user's prompts.
    """
    from sqlalchemy.exc import ProgrammingError

    with pytest.raises(ProgrammingError, match="permission denied"):
        await live_session.execute(
            text("SELECT prompt FROM catalog.tracks LIMIT 1")
        )
    await live_session.rollback()

    # ...while the one column the arbiter needs is readable.
    await live_session.execute(
        text("SELECT source_job_id FROM catalog.tracks LIMIT 1")
    )


# ── finalize_job end to end ────────────────────────────────────


def _service() -> GenerationService:
    return GenerationService(track_writer=CatalogService())


def _presigned(monkeypatch: pytest.MonkeyPatch) -> None:
    """Avoid needing real S3 credentials; presigning is signing, not storage."""
    from app.modules.generation import service as svc

    def fake_presign(key: str, expires: int = 900) -> str:
        return f"https://s3.example/{key}?X-Amz-Expires={expires}"

    monkeypatch.setattr(svc, "presign_get", fake_presign)


def _completed(hub: SSEHub, job_id: UUID) -> dict[str, Any]:
    return {
        "hub": hub,
        "job_id": job_id,
        "status": "COMPLETED",
        "s3_wav_key": _WAV_KEY,
        "s3_mp3_key": _MP3_KEY,
        "duration_seconds": 30,
        "waveform_hash": "c" * 64,
        "worker_id": "arn:aws:ecs:test",
    }


@pytest.mark.usefixtures("live_generation_engine")
async def test_completed_finalize_writes_all_three_rows(
    admin_session: AsyncSession,
    job_ids: dict[str, UUID],
    hub: SSEHub,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _presigned(monkeypatch)
    queue = hub.subscribe(str(job_ids["job"]))

    await _service().finalize_job(**_completed(hub, job_ids["job"]))

    assert await _job_status(admin_session, job_ids["job"]) == "COMPLETED"
    assert await _count_tracks(admin_session, job_ids["job"]) == 1
    assert await _count_prompts(admin_session, job_ids["job"]) == 1

    event = queue.get_nowait()
    assert event["event"] == "completed"
    assert event["data"]["track_id"] is not None
    assert "X-Amz-Expires=900" in event["data"]["mp3_url"]

    # The job row carries the outputs the SSE replay path reads back.
    row = (
        await admin_session.execute(
            text(
                """
                SELECT s3_wav_key, s3_mp3_key, duration_seconds, worker_id
                  FROM generation.jobs WHERE id = :jid
                """
            ),
            {"jid": str(job_ids["job"])},
        )
    ).mappings().one()
    assert row["s3_wav_key"] == _WAV_KEY
    assert row["s3_mp3_key"] == _MP3_KEY
    assert row["duration_seconds"] == 30
    assert row["worker_id"] == "arn:aws:ecs:test"


@pytest.mark.usefixtures("live_generation_engine")
async def test_replayed_finalize_is_a_no_op(
    admin_session: AsyncSession,
    job_ids: dict[str, UUID],
    hub: SSEHub,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Gate C6, API half: at-least-once SNS must not double-write or re-emit."""
    _presigned(monkeypatch)

    await _service().finalize_job(**_completed(hub, job_ids["job"]))
    queue = hub.subscribe(str(job_ids["job"]))   # subscribe AFTER the first
    await _service().finalize_job(**_completed(hub, job_ids["job"]))   # replay

    assert await _count_tracks(admin_session, job_ids["job"]) == 1
    assert await _count_prompts(admin_session, job_ids["job"]) == 1
    assert queue.empty()                          # no second `completed` frame


@pytest.mark.usefixtures("live_generation_engine")
async def test_failed_finalize_writes_no_track(
    admin_session: AsyncSession,
    job_ids: dict[str, UUID],
    hub: SSEHub,
) -> None:
    queue = hub.subscribe(str(job_ids["job"]))

    await _service().finalize_job(
        hub=hub,
        job_id=job_ids["job"],
        status="FAILED",
        error="CUDA out of memory",
        worker_id="arn:aws:ecs:test",
    )

    row = (
        await admin_session.execute(
            text("SELECT status, error FROM generation.jobs WHERE id = :jid"),
            {"jid": str(job_ids["job"])},
        )
    ).mappings().one()
    assert row["status"] == "FAILED"
    assert row["error"] == "CUDA out of memory"
    assert await _count_tracks(admin_session, job_ids["job"]) == 0

    event = queue.get_nowait()
    assert event["event"] == "failed"


@pytest.mark.usefixtures("live_generation_engine")
async def test_track_write_failure_rolls_back_the_job_update(
    admin_session: AsyncSession,
    job_ids: dict[str, UUID],
    hub: SSEHub,
) -> None:
    """
    Atomicity, stated as the property that matters: if the catalog write blows
    up, the job must NOT be left COMPLETED. Otherwise the user sees a finished
    job with nothing to play and no retry, because the terminal-status guard
    then blocks every redelivery.
    """

    class ExplodingWriter:
        # Parameter must be named `session` — the TrackWriter Protocol declares
        # it positionally-or-by-keyword, so a rename breaks conformance.
        async def create_track_in_txn(
            self, session: AsyncSession, **_kwargs: Any
        ) -> CreatedTrack:
            raise RuntimeError("catalog is on fire")

    service = GenerationService(track_writer=ExplodingWriter())

    with pytest.raises(RuntimeError, match="catalog is on fire"):
        await service.finalize_job(**_completed(hub, job_ids["job"]))

    assert await _job_status(admin_session, job_ids["job"]) == "QUEUED"
    assert await _count_tracks(admin_session, job_ids["job"]) == 0
