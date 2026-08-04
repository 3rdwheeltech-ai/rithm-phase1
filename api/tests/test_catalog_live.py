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


# ── Day 3: the catalog read path, on the CATALOG connection ────


@pytest.mark.usefixtures("live_catalog_engine")
async def test_get_track_for_generation_reads_on_the_catalog_connection(
    live_session: AsyncSession,
    admin_session: AsyncSession,
    job_ids: dict[str, UUID],
) -> None:
    """
    The parent lookup a variation/refine depends on.

    This is the test that proves the design decision in §B0.2: reading the
    parent's prompt and params needs table-level SELECT, rithm_generation
    deliberately does NOT have it, and so the read must run as rithm_catalog.
    The write below still goes through the generation session — mixing the two
    connections in one test is exactly the shape production runs.
    """
    await _write_track(live_session, job_ids)
    await live_session.commit()

    parent = await CatalogService().get_track_for_generation(
        track_id=await _track_id(admin_session, job_ids["job"]),
        user_id=job_ids["user"],
    )

    assert parent is not None
    assert parent["prompt"] == _PARAMS["prompt"]
    # params is the whole point: a variation copies it wholesale.
    assert parent["params"]["genre"] == "Lo-Fi"
    assert parent["params"]["bpm"] == 90
    assert parent["length_seconds"] == 30


@pytest.mark.usefixtures("live_catalog_engine")
async def test_get_track_for_generation_hides_another_users_track(
    live_session: AsyncSession,
    admin_session: AsyncSession,
    job_ids: dict[str, UUID],
) -> None:
    """None, not a row — the route turns it into a 404 rather than a 403."""
    await _write_track(live_session, job_ids)
    await live_session.commit()

    parent = await CatalogService().get_track_for_generation(
        track_id=await _track_id(admin_session, job_ids["job"]),
        user_id=_uuid(),
    )

    assert parent is None


async def test_finalize_writes_delta_command_for_a_refine(
    live_session: AsyncSession,
    admin_session: AsyncSession,
    job_ids: dict[str, UUID],
) -> None:
    """
    prompt_history.delta_command exists precisely for this, and Day 2 always
    wrote NULL. It rides in request_payload, so no new column and no new query.
    """
    await CatalogService().create_track_in_txn(
        live_session,
        user_id=job_ids["user"],
        source_job_id=job_ids["job"],
        kind="refine_fresh",
        prompt="a warm lo-fi loop. make it darker",
        params={**_PARAMS, "delta_command": "make it darker"},
        s3_wav_key=_WAV_KEY,
        s3_mp3_key=_MP3_KEY,
        waveform_hash="b" * 64,
        delta_command="make it darker",
    )
    await live_session.commit()

    row = (
        await admin_session.execute(
            text(
                """
                SELECT ph.kind, ph.delta_command
                  FROM catalog.prompt_history ph
                  JOIN catalog.tracks t ON t.id = ph.track_id
                 WHERE t.source_job_id = :jid
                """
            ),
            {"jid": str(job_ids["job"])},
        )
    ).first()

    assert row is not None
    # refine_fresh maps to prompt_history.kind='refine_fresh'; a `generate`
    # job would map to 'initial'. The two vocabularies differ on purpose.
    assert row.kind == "refine_fresh"
    assert row.delta_command == "make it darker"


async def _track_id(admin: AsyncSession, job_id: UUID) -> UUID:
    result = await admin.execute(
        text("SELECT id FROM catalog.tracks WHERE source_job_id = :jid"),
        {"jid": str(job_id)},
    )
    return UUID(str(result.scalar_one()))


# ── Day 3: the read surface, against real Postgres ─────────────
#
# These four are behavioural, not SQL-shape assertions, and none of them can be
# faked convincingly: keyset pagination is only correct if a real ORDER BY and a
# real row comparison agree, and "excluded" only means something when the row is
# genuinely present in the table and still does not come back.


@pytest_asyncio.fixture
async def seeded_tracks(
    admin_session: AsyncSession,
) -> AsyncIterator[dict[str, Any]]:
    """25 tracks for one user, plus one deleted and one owned by someone else."""
    owner, stranger = _uuid(), _uuid()
    job = _uuid()

    async def _insert(
        user_id: UUID, index: int, deleted: bool = False
    ) -> UUID:
        track_id = _uuid()
        await admin_session.execute(
            text(
                """
                INSERT INTO catalog.tracks
                    (id, user_id, source_job_id, genre, mood, bpm, vocal,
                     length_seconds, prompt, params, s3_wav_key, s3_mp3_key,
                     waveform_hash, created_at, deleted_at)
                VALUES
                    (:id, :user_id, :job, 'Lo-Fi', 'Calm', 85, false, 30,
                     :prompt, CAST(:params AS JSONB), :wav, :mp3, :hash,
                     now() - make_interval(secs => :offset),
                     CASE WHEN :deleted THEN now() ELSE NULL END)
                """
            ),
            {
                "id": str(track_id),
                "user_id": str(user_id),
                "job": str(_uuid()),
                "prompt": f"track {index}",
                "params": json.dumps({**_PARAMS, "index": index}),
                "wav": f"tracks/{index}/master.wav",
                "mp3": f"tracks/{index}/audio.mp3",
                "hash": "a" * 64,
                # Distinct created_at per row so the keyset order is total and
                # the assertions below are not at the mercy of a tie.
                "offset": index,
                "deleted": deleted,
            },
        )
        return track_id

    live = [await _insert(owner, i) for i in range(25)]
    deleted = await _insert(owner, 99, deleted=True)
    foreign = await _insert(stranger, 98)
    await admin_session.commit()

    yield {
        "owner": owner,
        "stranger": stranger,
        "live": live,
        "deleted": deleted,
        "foreign": foreign,
    }

    for user in (owner, stranger):
        await admin_session.execute(
            text("DELETE FROM catalog.tracks WHERE user_id = :uid"),
            {"uid": str(user)},
        )
    await admin_session.execute(
        text("DELETE FROM generation.jobs WHERE id = :jid"), {"jid": str(job)}
    )
    await admin_session.commit()


@pytest.mark.usefixtures("live_catalog_engine")
async def test_keyset_pagination_walks_without_overlap_or_gap(
    seeded_tracks: dict[str, Any],
) -> None:
    """
    Three pages of ten over 25 rows. The properties that matter are that every
    track appears EXACTLY once and that the last page stops advertising a
    cursor — an off-by-one in the limit+1 handling breaks one or the other.
    """
    service = CatalogService()
    owner = seeded_tracks["owner"]

    seen: list[UUID] = []
    cursor: tuple[Any, UUID] | None = None
    pages = 0

    while True:
        tracks, has_more, total = await service.list_tracks(
            user_id=owner, limit=10, cursor=cursor
        )
        pages += 1
        seen.extend(track.id for track in tracks)
        assert total == 25, "the deleted and foreign rows must not be counted"
        if not has_more:
            break
        cursor = (tracks[-1].created_at, tracks[-1].id)
        assert pages < 10, "pagination did not terminate"

    assert pages == 3
    assert len(seen) == 25
    assert len(set(seen)) == 25, "a track was returned on two different pages"
    assert set(seen) == set(seeded_tracks["live"])


@pytest.mark.usefixtures("live_catalog_engine")
async def test_list_is_newest_first(seeded_tracks: dict[str, Any]) -> None:
    tracks, _, _ = await CatalogService().list_tracks(
        user_id=seeded_tracks["owner"], limit=25, cursor=None
    )
    timestamps = [track.created_at for track in tracks]
    assert timestamps == sorted(timestamps, reverse=True)


@pytest.mark.usefixtures("live_catalog_engine")
async def test_list_excludes_deleted_and_other_users(
    seeded_tracks: dict[str, Any],
) -> None:
    """Both rows genuinely exist in the table; neither may come back."""
    service = CatalogService()
    owner = seeded_tracks["owner"]

    tracks, _, total = await service.list_tracks(
        user_id=owner, limit=100, cursor=None
    )
    returned = {track.id for track in tracks}

    assert seeded_tracks["deleted"] not in returned
    assert seeded_tracks["foreign"] not in returned
    assert total == 25

    # ...and the same two are unreachable by direct fetch, as 404s rather than
    # as 403s: get_track cannot distinguish "deleted", "not yours" and "absent".
    assert await service.get_track(
        track_id=seeded_tracks["deleted"], user_id=owner
    ) is None
    assert await service.get_track(
        track_id=seeded_tracks["foreign"], user_id=owner
    ) is None


@pytest.mark.usefixtures("live_catalog_engine")
async def test_soft_delete_hides_the_row_but_keeps_it(
    seeded_tracks: dict[str, Any], admin_session: AsyncSession
) -> None:
    """
    Soft means recoverable. The row must survive with deleted_at set, and the
    second delete must report False so the route can 404 rather than lie.
    """
    service = CatalogService()
    owner = seeded_tracks["owner"]
    target = seeded_tracks["live"][0]

    assert await service.soft_delete_track(track_id=target, user_id=owner)
    assert await service.get_track(track_id=target, user_id=owner) is None
    # Idempotent: nothing left to delete.
    assert not await service.soft_delete_track(track_id=target, user_id=owner)

    row = (
        await admin_session.execute(
            text(
                "SELECT deleted_at FROM catalog.tracks WHERE id = :id"
            ),
            {"id": str(target)},
        )
    ).first()
    assert row is not None, "soft delete must not remove the row"
    assert row.deleted_at is not None

    _, _, total = await service.list_tracks(
        user_id=owner, limit=100, cursor=None
    )
    assert total == 24


@pytest.mark.usefixtures("live_catalog_engine")
async def test_soft_delete_refuses_another_users_track(
    seeded_tracks: dict[str, Any],
) -> None:
    assert not await CatalogService().soft_delete_track(
        track_id=seeded_tracks["foreign"], user_id=seeded_tracks["owner"]
    )
