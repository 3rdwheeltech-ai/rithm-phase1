"""
finalize_job's terminal-only transition and its atomic catalog write.

Two properties are under test and both are load-bearing for Gate C:

1. **Idempotency.** The guarded UPDATE is the API-side half of not
   double-emitting on a duplicate SNS delivery (the worker's claim UPDATE is the
   other half). If it matched no row, nothing may reach the SSE hub and no track
   may be written — otherwise a redelivered completion produces a second
   `completed` frame and a second track.

2. **Atomicity.** The job UPDATE and both catalog INSERTs must land on ONE
   session, so the single commit at context exit covers all three. Asserting
   they share a session object is how that is checked here; the live-DB suite
   in test_catalog_live.py proves the transaction actually holds against
   Postgres, including the cross-schema grant.
"""
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import pytest

from app.modules.generation import service as generation_service_module
from app.modules.generation.interfaces import CreatedTrack
from app.modules.generation.service import GenerationService
from app.modules.generation.sse_hub import SSEHub
from tests.conftest import FakeSession

_JOB = UUID("01920000-0000-7000-8000-00000000abcd")
_USER = UUID("01920000-0000-7000-8000-0000000000bb")

_PAYLOAD: dict[str, Any] = {
    "prompt": "a warm lo-fi loop",
    "genre": "Lo-Fi",
    "mood": "Calm",
    "bpm": 90,
    "instruments": [],
    "vocal": False,
    "length_seconds": 30,
    "seed": None,
}

# What the COMPLETED UPDATE ... RETURNING user_id, kind, request_payload yields.
_RETURNED_ROW: tuple[str, str, Any] = (str(_USER), "generate", _PAYLOAD)


class FakeRow:
    """A Row with attribute access, which is how service.py reads it."""

    def __init__(self, user_id: str, kind: str, payload: dict[str, Any]) -> None:
        self.user_id = user_id
        self.kind = kind
        self.request_payload = payload


class FakeTrackWriter:
    """Records the catalog call and the session it was handed."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.sessions: list[Any] = []

    async def create_track_in_txn(
        self, session: Any, **kwargs: Any
    ) -> CreatedTrack:
        self.sessions.append(session)
        self.calls.append(kwargs)
        return {
            "track_id": UUID("01920000-0000-7000-8000-00000000face"),
            "mp3_key": str(kwargs["s3_mp3_key"]),
        }


def _patch_session(
    monkeypatch: pytest.MonkeyPatch, results: list[list[Any]]
) -> FakeSession:
    session = FakeSession(results)

    @asynccontextmanager
    async def _session(_module: str) -> AsyncIterator[Any]:
        yield session

    monkeypatch.setattr(generation_service_module, "get_session", _session)
    return session


def _patch_presign(monkeypatch: pytest.MonkeyPatch) -> None:
    """Presigning is local signing, but it still needs a configured bucket."""

    def fake_presign(key: str, expires: int = 900) -> str:
        return f"https://s3.example/{key}?X-Amz-Expires={expires}"

    monkeypatch.setattr(
        generation_service_module, "presign_get", fake_presign
    )


def _service(writer: FakeTrackWriter | None = None) -> GenerationService:
    return GenerationService(track_writer=writer or FakeTrackWriter())


def _completed_kwargs(hub: SSEHub) -> dict[str, Any]:
    return {
        "hub": hub,
        "job_id": _JOB,
        "status": "COMPLETED",
        "s3_wav_key": "tracks/u/j/master.wav",
        "s3_mp3_key": "tracks/u/j/audio.mp3",
        "duration_seconds": 30,
        "waveform_hash": "a" * 64,
        "worker_id": "arn:aws:ecs:...",
    }


@pytest.mark.asyncio
async def test_completed_updates_and_publishes(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_session(monkeypatch, [[FakeRow(*_RETURNED_ROW)]])
    _patch_presign(monkeypatch)
    queue = hub.subscribe(str(_JOB))

    await _service().finalize_job(**_completed_kwargs(hub))

    event = queue.get_nowait()
    assert event["event"] == "completed"
    assert event["data"]["s3_mp3_key"] == "tracks/u/j/audio.mp3"
    assert event["data"]["duration_seconds"] == 30
    # ── the Day-2 additions ──
    assert event["data"]["track_id"] == "01920000-0000-7000-8000-00000000face"
    assert event["data"]["mp3_url"].startswith("https://s3.example/")
    assert "X-Amz-Expires=900" in event["data"]["mp3_url"]


@pytest.mark.asyncio
async def test_completed_writes_track_on_the_same_session(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """All three writes share one session, so one commit covers them all."""
    session = _patch_session(monkeypatch, [[FakeRow(*_RETURNED_ROW)]])
    _patch_presign(monkeypatch)
    writer = FakeTrackWriter()

    await _service(writer).finalize_job(**_completed_kwargs(hub))

    assert len(writer.calls) == 1
    assert writer.sessions == [session]     # the generation session, not a new one

    call = writer.calls[0]
    assert call["user_id"] == _USER
    assert call["source_job_id"] == _JOB
    assert call["kind"] == "generate"
    assert call["prompt"] == "a warm lo-fi loop"
    assert call["params"] == _PAYLOAD
    assert call["s3_wav_key"] == "tracks/u/j/master.wav"
    assert call["waveform_hash"] == "a" * 64


@pytest.mark.asyncio
async def test_track_is_written_before_the_transaction_closes(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    Ordering proof: the writer must be called while the session is still open.
    FakeSession records nothing after exit, so if the catalog write had been
    moved out of the block it would run against a closed session in production.
    """
    _patch_session(monkeypatch, [[FakeRow(*_RETURNED_ROW)]])
    _patch_presign(monkeypatch)
    writer = FakeTrackWriter()

    await _service(writer).finalize_job(**_completed_kwargs(hub))

    assert writer.sessions[0].executed[0][0].strip().startswith(
        "UPDATE generation.jobs"
    )


@pytest.mark.asyncio
async def test_failed_publishes_error_and_writes_no_track(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_session(monkeypatch, [[(str(_JOB),)]])
    writer = FakeTrackWriter()
    queue = hub.subscribe(str(_JOB))

    await _service(writer).finalize_job(
        hub=hub, job_id=_JOB, status="FAILED", error="CUDA OOM"
    )

    event = queue.get_nowait()
    assert event["event"] == "failed"
    assert event["data"]["error"] == "CUDA OOM"
    assert writer.calls == []       # a failed job has no track


@pytest.mark.asyncio
async def test_already_terminal_does_not_publish_or_write_track(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The replay case — SNS is at-least-once, so this is routine."""
    # UPDATE matched nothing; the follow-up SELECT finds it already COMPLETED.
    _patch_session(monkeypatch, [[], [("COMPLETED",)]])
    writer = FakeTrackWriter()
    queue = hub.subscribe(str(_JOB))

    await _service(writer).finalize_job(**_completed_kwargs(hub))

    assert queue.empty()
    assert writer.calls == []       # no duplicate track


@pytest.mark.asyncio
async def test_unknown_job_id_does_not_publish_or_raise(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    # UPDATE matched nothing and the SELECT finds no row at all.
    _patch_session(monkeypatch, [[], []])
    writer = FakeTrackWriter()
    queue = hub.subscribe(str(_JOB))

    await _service(writer).finalize_job(**_completed_kwargs(hub))

    assert queue.empty()
    assert writer.calls == []


@pytest.mark.asyncio
async def test_update_is_guarded_on_non_terminal_status(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _patch_session(monkeypatch, [[FakeRow(*_RETURNED_ROW)]])
    _patch_presign(monkeypatch)

    await _service().finalize_job(**_completed_kwargs(hub))

    update_sql = session.executed[0][0]
    assert "UPDATE generation.jobs" in update_sql
    assert "status NOT IN ('COMPLETED', 'FAILED', 'DEAD_LETTERED')" in update_sql
    # COALESCE so a partial envelope cannot null out outputs already stored.
    assert "COALESCE(:s3_mp3_key, s3_mp3_key)" in update_sql
    # RETURNING now carries what the track needs, in the same round trip.
    assert "RETURNING user_id, kind, request_payload" in update_sql


@pytest.mark.asyncio
async def test_unbound_track_writer_raises_rather_than_losing_the_track(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    create_app() always injects the writer. If a future refactor stops doing so,
    fail loudly: the transaction rolls back, the job stays non-terminal, and SNS
    redelivers — versus committing a COMPLETED job no track points at.
    """
    _patch_session(monkeypatch, [[FakeRow(*_RETURNED_ROW)]])
    service = GenerationService(track_writer=None)

    with pytest.raises(RuntimeError, match="track_writer is not bound"):
        await service.finalize_job(**_completed_kwargs(hub))


@pytest.mark.asyncio
async def test_completed_envelope_missing_keys_raises(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """catalog.tracks NOT NULLs these; better to roll back than to guess."""
    _patch_session(monkeypatch, [[FakeRow(*_RETURNED_ROW)]])

    with pytest.raises(ValueError, match="missing"):
        await _service().finalize_job(
            hub=hub, job_id=_JOB, status="COMPLETED", s3_mp3_key="x.mp3"
        )


@pytest.mark.asyncio
async def test_request_payload_is_accepted_as_json_string(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    asyncpg's JSONB codec normally hands back a dict, but the decode must
    survive a driver or codec change rather than crashing a completion.
    """
    import json

    _patch_session(
        monkeypatch,
        [[FakeRow(str(_USER), "generate", json.dumps(_PAYLOAD))]],  # type: ignore[arg-type]
    )
    _patch_presign(monkeypatch)
    writer = FakeTrackWriter()

    await _service(writer).finalize_job(**_completed_kwargs(hub))

    assert writer.calls[0]["params"] == _PAYLOAD
    assert writer.calls[0]["prompt"] == "a warm lo-fi loop"
