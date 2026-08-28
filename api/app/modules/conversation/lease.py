"""
The single Anam session slot, arbitrated in this process — and the per-user
daily cap on session starts that sits in front of it.

WHY THIS EXISTS AT ALL. The free tier's "1 concurrent session" is a property of
the API KEY, not of a user. Without arbitration the second person in the entire
product to press Talk gets a bare 429 from Anam: no Retry-After a client can
act on, no way to tell "someone else is talking" from "the vendor is down", and
no way to know when the slot frees. Worse, a client that hangs on past its
session parks the slot invisibly. Arbitrating here turns an unowned vendor race
into a deterministic refusal with a computable wait.

EXACT ONLY AT desiredCount=1, which is a property this deployment already
depends on for the SSE hub (api/Dockerfile: "SINGLE process — do NOT add
--workers"). There is exactly one arbiter, so an in-process lease is correct
rather than approximate — the same reasoning agent.py uses to memoise
`_preferred_model_id` in a module global. If desiredCount ever leaves 1, this
file is the second thing that breaks and it must move into the database
alongside the hub.

ADVISORY TOWARD ANAM. Anam knows nothing about this lease, so the TTL must be
at least the session cap plus slack — a client that outlives its lease will
still 429 the next holder at the vendor, and the lease will have lied.

REMOVAL CONDITION, stated now so it is not archaeology later: this file exists
because the plan has ONE slot. On a plan with N concurrent sessions it becomes
a counting semaphore. Both state resets on deploy, and that honest cost is
smaller than a migration for a 30-minute monthly budget.
"""

import asyncio
import time
from dataclasses import dataclass
from uuid import UUID

import structlog

logger = structlog.get_logger()

_DAY_SECONDS = 86_400


def _now() -> float:
    """
    A monotonic clock, behind one name.

    Indirected so tests can age a lease without monkeypatching `time.monotonic`
    globally — which asyncio also reads, from inside the loop these coroutines
    are running on.
    """
    return time.monotonic()


@dataclass(frozen=True, slots=True)
class Lease:
    lease_id: UUID
    user_id: UUID
    expires_at: float  # on _now()'s clock, not wall time


class VoiceLease:
    """
    One slot, or nobody's.

    An expiring TTL is the backstop and the REAL guarantee: the client's
    release runs on `pagehide` through `fetch(..., {keepalive: true})`, which
    Firefox before 133 does not implement at all. The recovery story is the
    TTL; the release is an optimisation on top of it.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._held: Lease | None = None

    async def claim(self, *, user_id: UUID, lease_id: UUID, ttl_seconds: int) -> Lease:
        """
        Take the slot, or report how long until it frees.

        Returns the new lease. Raises VoiceAtCapacityException — imported
        lazily, see below — when someone ELSE holds a live one.
        """
        # Imported inside the method rather than at module scope so this file
        # stays importable by a test that only wants the timing behaviour.
        from app.shared.exceptions import VoiceAtCapacityException

        async with self._lock:
            now = _now()
            held = self._held
            live = held is not None and held.expires_at > now

            if live and held is not None and held.user_id != user_id:
                # A real number, not a guess: this is the whole reason the lease
                # exists rather than letting Anam's bare 429 through.
                remaining = max(1, int(held.expires_at - now) + 1)
                raise VoiceAtCapacityException(retry_after_seconds=remaining)

            # The SAME user reclaims rather than being refused. A reload
            # mid-session must not lock someone out of a slot they are already
            # holding — and React.StrictMode's double effect would otherwise
            # 429 the second half of every start in development.
            lease = Lease(
                lease_id=lease_id,
                user_id=user_id,
                expires_at=now + ttl_seconds,
            )
            self._held = lease
            return lease

    async def release(self, *, lease_id: UUID, user_id: UUID) -> None:
        """
        Give the slot back. Idempotent — releasing a lease you do not hold is
        already the desired end state.

        BOTH ids are checked. A stale tab's unload must not free the slot the
        user's current tab is holding, and that is not hypothetical: reclaim
        above hands the same user a NEW lease_id, so the old tab's `pagehide`
        arrives carrying a lease that is genuinely no longer current.
        """
        async with self._lock:
            held = self._held
            if held is None:
                return
            if held.lease_id != lease_id or held.user_id != user_id:
                return
            self._held = None

    async def reset(self) -> None:
        """Drop the slot unconditionally. Tests only."""
        async with self._lock:
            self._held = None


class VoiceStartCounter:
    """
    Session STARTS per user in a rolling 24 hours — not turns.

    Stops one user churning start/stop through a 30-minute monthly budget. In
    process for the same reason the lease is, and with the same honest cost: it
    resets on deploy. A table for it is explicitly out of scope.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._starts: dict[UUID, list[float]] = {}

    async def count(self, *, user_id: UUID) -> int:
        async with self._lock:
            return len(self._prune(user_id))

    async def record(self, *, user_id: UUID) -> None:
        """
        Count a start.

        Called AFTER a successful mint, deliberately: a session that never
        started is not a start, and charging a user for a vendor outage is the
        kind of thing that reads as the app being broken twice.
        """
        async with self._lock:
            self._prune(user_id).append(_now())

    async def reset(self) -> None:
        """Tests only."""
        async with self._lock:
            self._starts.clear()

    def _prune(self, user_id: UUID) -> list[float]:
        """The user's live start times, oldest expired ones dropped. Lock held."""
        cutoff = _now() - _DAY_SECONDS
        kept = [at for at in self._starts.get(user_id, []) if at > cutoff]
        self._starts[user_id] = kept
        return kept


# Module singletons, matching conversation_service: patching one thing in a
# test beats patching two that behave alike.
voice_lease = VoiceLease()
voice_starts = VoiceStartCounter()
