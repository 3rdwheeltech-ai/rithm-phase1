"""
The stuck-job sweeper.

Two sweeps, and the QUEUED one matters most: a job whose SQS send failed sits
QUEUED forever while the user's SSE stream hangs until their browser gives up.
Nothing else in the system notices.

These tests assert the SQL shape and the SSE side effects against FakeSession —
what could go wrong here is sweeping the wrong column, publishing before the
commit, or a bad tick taking the event loop down with it, and none of those need
a real database to catch.
"""
import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID, uuid4

import pytest

from app.modules.generation import service as generation_service_module
from app.modules.generation.service import GenerationService
from app.modules.generation.sse_hub import SSEHub
from tests.conftest import FakeSession


class _IdRow:
    def __init__(self, job_id: UUID) -> None:
        self.id = job_id


def _patch_session(
    monkeypatch: pytest.MonkeyPatch, results: list[list[Any]]
) -> list[FakeSession]:
    opened: list[FakeSession] = []

    @asynccontextmanager
    async def _session(_module: str) -> AsyncIterator[FakeSession]:
        session = FakeSession(results=results)
        opened.append(session)
        yield session

    monkeypatch.setattr(generation_service_module, "get_session", _session)
    return opened


@pytest.mark.asyncio
async def test_sweeps_stale_running_jobs(
    monkeypatch: pytest.MonkeyPatch, hub: SSEHub
) -> None:
    stale = uuid4()
    sessions = _patch_session(monkeypatch, [[_IdRow(stale)], []])
    queue = hub.subscribe(str(stale))

    failed = await GenerationService().sweep_stuck_jobs(hub)

    assert failed == 1
    statement, params = sessions[0].executed[0]
    assert "status = 'RUNNING'" in statement
    # RUNNING is measured from started_at — a job that has been running ten
    # minutes, not one that was created ten minutes ago and queued for nine.
    assert "started_at <" in statement
    assert params["secs"] == 600

    event = queue.get_nowait()
    assert event["event"] == "failed"
    assert event["data"]["job_id"] == str(stale)
    assert "timed out" in event["data"]["error"]


@pytest.mark.asyncio
async def test_sweeps_orphan_queued_jobs(
    monkeypatch: pytest.MonkeyPatch, hub: SSEHub
) -> None:
    orphan = uuid4()
    sessions = _patch_session(monkeypatch, [[], [_IdRow(orphan)]])
    queue = hub.subscribe(str(orphan))

    failed = await GenerationService().sweep_stuck_jobs(hub)

    assert failed == 1
    statement, params = sessions[0].executed[1]
    assert "status = 'QUEUED'" in statement
    # QUEUED is measured from created_at: the job never started.
    assert "created_at <" in statement
    # 1800s is a FLOOR. It must exceed cold start (4-6 min on a 12 GB image)
    # plus queue wait plus max generation, or the sweeper fails healthy jobs
    # while the ASG is still booting.
    assert params["secs"] == 1800

    assert queue.get_nowait()["data"]["job_id"] == str(orphan)


@pytest.mark.asyncio
async def test_a_clean_sweep_publishes_nothing(
    monkeypatch: pytest.MonkeyPatch, hub: SSEHub
) -> None:
    _patch_session(monkeypatch, [[], []])
    queue = hub.subscribe("anything")

    assert await GenerationService().sweep_stuck_jobs(hub) == 0
    assert queue.empty()


@pytest.mark.asyncio
async def test_a_second_sweep_is_a_no_op(
    monkeypatch: pytest.MonkeyPatch, hub: SSEHub
) -> None:
    """
    UPDATE ... RETURNING is the guard: the first sweep moves the row out of
    RUNNING, so the second matches nothing. That is also what stops two API
    tasks double-failing the same job.
    """
    stale = uuid4()
    service = GenerationService()

    _patch_session(monkeypatch, [[_IdRow(stale)], []])
    assert await service.sweep_stuck_jobs(hub) == 1

    _patch_session(monkeypatch, [[], []])
    assert await service.sweep_stuck_jobs(hub) == 0


@pytest.mark.asyncio
async def test_thresholds_are_configurable(
    monkeypatch: pytest.MonkeyPatch, hub: SSEHub
) -> None:
    from app.config import get_settings

    monkeypatch.setenv("STUCK_RUNNING_SECONDS", "30")
    monkeypatch.setenv("STUCK_QUEUED_SECONDS", "60")
    get_settings.cache_clear()

    sessions = _patch_session(monkeypatch, [[], []])
    await GenerationService().sweep_stuck_jobs(hub)

    assert sessions[0].executed[0][1]["secs"] == 30
    assert sessions[0].executed[1][1]["secs"] == 60
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_a_failing_tick_does_not_kill_the_loop(
    monkeypatch: pytest.MonkeyPatch, hub: SSEHub
) -> None:
    """
    The single most important property of this code. A sweeper that propagates
    one bad DB moment out of its task takes the API's event loop with it.
    """
    from app.config import get_settings

    monkeypatch.setenv("SWEEPER_INTERVAL_SECONDS", "0")
    get_settings.cache_clear()
    monkeypatch.setattr(
        generation_service_module, "_SWEEPER_TICK_SECONDS", 0.001
    )

    calls = 0

    async def _explode(_hub: SSEHub) -> int:
        nonlocal calls
        calls += 1
        raise RuntimeError("database went away")

    service = GenerationService()
    monkeypatch.setattr(service, "sweep_stuck_jobs", _explode)

    task = asyncio.create_task(service.run_sweeper(hub))
    # Wait on the condition rather than a fixed sleep: each failed tick logs a
    # full traceback, which is slow enough that a fixed window is flaky.
    deadline = asyncio.get_running_loop().time() + 5.0
    while calls < 2 and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)

    assert not task.done(), "the loop died on a failing tick"
    assert calls >= 2, "the loop stopped ticking after the first failure"

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_the_loop_stops_promptly_on_cancellation(
    monkeypatch: pytest.MonkeyPatch, hub: SSEHub
) -> None:
    """
    The short tick exists for exactly this: lifespan cancels the task on
    shutdown and awaits it, and a 300-second sleep would hold the process open.
    """
    monkeypatch.setattr(
        generation_service_module, "_SWEEPER_TICK_SECONDS", 0.001
    )
    _patch_session(monkeypatch, [[], []])

    service = GenerationService()
    task = asyncio.create_task(service.run_sweeper(hub))
    await asyncio.sleep(0.01)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=1.0)
