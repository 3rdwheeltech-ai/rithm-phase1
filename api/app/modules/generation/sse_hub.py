"""
In-process SSE pub/sub, keyed by job_id.

This is why the API runs as a single process (no --workers, no Gunicorn) and at
desiredCount=1: a completion delivered to process/task A never reaches a stream
held on B. The hub deliberately has no Redis backing — that is a Phase-2
decision, not a Day-1 one.

One event loop and cooperative scheduling mean a plain dict/set is safe, as
long as publish() snapshots before iterating.
"""

import asyncio
from collections import defaultdict
from contextlib import suppress

from app.modules.generation.schemas import SSEEvent

# Bounded per subscriber. A slow client is dropped, never blocks a publisher —
# it reconnects with the same token and replays current state from
# generation.jobs.
_QUEUE_MAXSIZE = 64


class SSEHub:
    def __init__(self) -> None:
        # NOTHING loop-bound may be constructed here (no Lock, no Queue, no
        # get_event_loop): the hub is built in create_app(), which runs at
        # import time, outside any running loop. Queues are created in
        # subscribe(), which only ever runs inside a request.
        self._subs: dict[str, set[asyncio.Queue[SSEEvent]]] = defaultdict(set)

    def subscribe(self, job_id: str) -> asyncio.Queue[SSEEvent]:
        queue: asyncio.Queue[SSEEvent] = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
        self._subs[job_id].add(queue)
        return queue

    def unsubscribe(self, job_id: str, queue: asyncio.Queue[SSEEvent]) -> None:
        subs = self._subs.get(job_id)
        if subs:
            subs.discard(queue)
            if not subs:
                self._subs.pop(job_id, None)

    def publish(self, job_id: str, event: SSEEvent) -> None:
        # list(...) snapshots, so a subscriber unsubscribing mid-iteration
        # cannot mutate the set under us.
        for queue in list(self._subs.get(job_id, ())):
            # Slow consumer → drop. Never block a publisher; the client
            # reconnects and replays current state from generation.jobs.
            with suppress(asyncio.QueueFull):
                queue.put_nowait(event)

    def subscriber_count(self, job_id: str) -> int:
        return len(self._subs.get(job_id, ()))
