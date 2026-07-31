import asyncio

import pytest

from app.modules.generation.schemas import SSEEvent
from app.modules.generation.sse_hub import SSEHub

_JOB = "01920000-0000-7000-8000-00000000abcd"


def _event(name: str = "queued") -> SSEEvent:
    return {"event": name, "data": {"job_id": _JOB}}  # type: ignore[typeddict-item]


def test_init_needs_no_running_loop() -> None:
    """
    Regression guard: the hub is built in create_app(), which runs at import
    time outside any event loop. Anything loop-bound in __init__ would blow up
    there and only there.
    """
    assert SSEHub().subscriber_count(_JOB) == 0


@pytest.mark.asyncio
async def test_publish_delivers_to_subscriber(hub: SSEHub) -> None:
    queue = hub.subscribe(_JOB)
    hub.publish(_JOB, _event())
    assert (await queue.get())["event"] == "queued"


@pytest.mark.asyncio
async def test_two_subscribers_both_receive(hub: SSEHub) -> None:
    first, second = hub.subscribe(_JOB), hub.subscribe(_JOB)
    hub.publish(_JOB, _event("running"))
    assert (await first.get())["event"] == "running"
    assert (await second.get())["event"] == "running"


@pytest.mark.asyncio
async def test_unsubscribe_stops_delivery_and_prunes(hub: SSEHub) -> None:
    queue = hub.subscribe(_JOB)
    hub.unsubscribe(_JOB, queue)
    hub.publish(_JOB, _event())
    assert queue.empty()
    assert hub.subscriber_count(_JOB) == 0


@pytest.mark.asyncio
async def test_queue_full_drops_without_raising(hub: SSEHub) -> None:
    queue = hub.subscribe(_JOB)
    # maxsize is 64; the 65th publish must be dropped, never block a publisher.
    for _ in range(70):
        hub.publish(_JOB, _event())
    assert queue.qsize() == 64


def test_publish_with_no_subscribers_is_noop(hub: SSEHub) -> None:
    hub.publish("no-such-job", _event())
    assert hub.subscriber_count("no-such-job") == 0


@pytest.mark.asyncio
async def test_unsubscribe_unknown_queue_is_safe(hub: SSEHub) -> None:
    stray: asyncio.Queue[SSEEvent] = asyncio.Queue()
    hub.unsubscribe(_JOB, stray)  # must not raise
