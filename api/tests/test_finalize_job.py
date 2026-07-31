"""
finalize_job's terminal-only transition.

This is the API-side half of not double-emitting on a duplicate SNS delivery
(the worker's claim UPDATE is the other half). If the guarded UPDATE matched no
row, nothing may reach the SSE hub — otherwise a redelivered completion
produces a second `completed` frame on any stream still open.
"""
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import pytest

from app.modules.generation import service as generation_service_module
from app.modules.generation.service import generation_service
from app.modules.generation.sse_hub import SSEHub
from tests.conftest import FakeSession

_JOB = UUID("01920000-0000-7000-8000-00000000abcd")


def _patch_session(
    monkeypatch: pytest.MonkeyPatch, results: list[list[Any]]
) -> FakeSession:
    session = FakeSession(results)

    @asynccontextmanager
    async def _session(_module: str) -> Any:
        yield session

    monkeypatch.setattr(generation_service_module, "get_session", _session)
    return session


@pytest.mark.asyncio
async def test_completed_updates_and_publishes(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_session(monkeypatch, [[(str(_JOB),)]])  # UPDATE ... RETURNING id
    queue = hub.subscribe(str(_JOB))

    await generation_service.finalize_job(
        hub=hub,
        job_id=_JOB,
        status="COMPLETED",
        s3_mp3_key="tracks/u/j/audio.mp3",
        s3_wav_key="tracks/u/j/master.wav",
        duration_seconds=30,
        worker_id="arn:aws:ecs:...",
    )

    event = queue.get_nowait()
    assert event["event"] == "completed"
    assert event["data"]["s3_mp3_key"] == "tracks/u/j/audio.mp3"
    assert event["data"]["duration_seconds"] == 30


@pytest.mark.asyncio
async def test_failed_publishes_error(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_session(monkeypatch, [[(str(_JOB),)]])
    queue = hub.subscribe(str(_JOB))

    await generation_service.finalize_job(
        hub=hub, job_id=_JOB, status="FAILED", error="CUDA OOM"
    )

    event = queue.get_nowait()
    assert event["event"] == "failed"
    assert event["data"]["error"] == "CUDA OOM"


@pytest.mark.asyncio
async def test_already_terminal_does_not_publish(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    # UPDATE matched nothing; the follow-up SELECT finds it already COMPLETED.
    _patch_session(monkeypatch, [[], [("COMPLETED",)]])
    queue = hub.subscribe(str(_JOB))

    await generation_service.finalize_job(
        hub=hub, job_id=_JOB, status="COMPLETED", s3_mp3_key="x.mp3"
    )

    assert queue.empty()


@pytest.mark.asyncio
async def test_unknown_job_id_does_not_publish_or_raise(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    # UPDATE matched nothing and the SELECT finds no row at all.
    _patch_session(monkeypatch, [[], []])
    queue = hub.subscribe(str(_JOB))

    await generation_service.finalize_job(
        hub=hub, job_id=_JOB, status="COMPLETED"
    )

    assert queue.empty()


@pytest.mark.asyncio
async def test_update_is_guarded_on_non_terminal_status(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _patch_session(monkeypatch, [[(str(_JOB),)]])
    await generation_service.finalize_job(
        hub=hub, job_id=_JOB, status="COMPLETED"
    )
    update_sql = session.executed[0][0]
    assert "UPDATE generation.jobs" in update_sql
    assert "status NOT IN ('COMPLETED', 'FAILED', 'DEAD_LETTERED')" in update_sql
    # COALESCE so a partial envelope cannot null out outputs already stored.
    assert "COALESCE(:s3_mp3_key, s3_mp3_key)" in update_sql
