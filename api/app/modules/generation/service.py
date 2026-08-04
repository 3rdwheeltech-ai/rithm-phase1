"""
Generation service — job submission, state read-back, and completion.

Unlike identity/service.py, this service opens its own sessions rather than
taking one from a FastAPI dependency. The reason is the SSE route: a
request-scoped session is torn down only after the response completes, so a
5-minute stream would pin a pooled connection (pool_size=5 + max_overflow=5 →
10 concurrent streams, then everything blocks).

Direction of travel is fixed: this module SendMessages to SQS and never
receives; the Day-2 worker is the only consumer.
"""
import asyncio
import json
import secrets
from datetime import UTC, datetime, timedelta
from math import ceil
from typing import Any, cast
from uuid import UUID

import structlog
from sqlalchemy import Row, text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid_utils import uuid7

from app.config import get_settings
from app.modules.generation.interfaces import (
    CreatedTrack,
    ParentTrack,
    TrackReader,
    TrackWriter,
)
from app.modules.generation.models import (
    JOB_COLUMNS,
    JobKind,
    JobRow,
    JobStatus,
    JobStatusRow,
)
from app.modules.generation.schemas import GenerationParams, SSEEvent
from app.modules.generation.sse_hub import SSEHub
from app.shared.aws import presign_get, send_sqs_message
from app.shared.db import get_session

logger = structlog.get_logger()
_settings = get_settings()

# Bumping this is how the Day-2 worker learns the envelope changed shape; the
# worker DLQs any version it does not recognise.
SQS_SCHEMA_VERSION = 1

# Launch plan §2.1: playback is an S3 presigned GET, 15-minute TTL.
_MP3_URL_TTL_SECONDS = 900

# How often the sweeper loop wakes, NOT how often it sweeps. Short so shutdown
# cancellation is handled promptly; sweeper_interval_seconds gates the work.
_SWEEPER_TICK_SECONDS = 60.0

# The rolling-window predicate, spelled once. FAILED and DEAD_LETTERED are
# excluded on purpose: a user whose job failed did not consume a generation,
# and charging them for it is how a bad night turns into a support ticket.
RATE_WINDOW_COUNT_SQL = """
    SELECT count(*) FROM generation.jobs
     WHERE user_id = CAST(:user_id AS uuid)
       AND created_at > now() - interval '24 hours'
       AND status IN ('QUEUED', 'RUNNING', 'COMPLETED')
"""


class RateLimitedError(Exception):
    """The 24h window is full. The route turns this into a 429."""

    def __init__(self, *, used: int, limit: int, retry_after_seconds: int) -> None:
        super().__init__(f"rate limit {used}/{limit}")
        self.used = used
        self.limit = limit
        self.retry_after_seconds = retry_after_seconds


class EnqueueFailedError(Exception):
    """
    The job row committed but SQS would not take the message.

    The job has already been marked FAILED by the time this is raised; the
    route turns it into a 503 with a Retry-After.
    """


def new_seed() -> int:
    """
    A fresh generation seed.

    Minted API-side, never by the worker: recording it in request_payload (and
    so in catalog.tracks.params) is what makes a generation reproducible, and
    what makes TTM-04 — "a variation is the same params with a different seed"
    — a statement you can check rather than assert.
    """
    return secrets.randbelow(2**31 - 1) + 1


def new_seed_distinct_from(previous: int | None) -> int:
    """
    A seed guaranteed to differ from the parent's.

    A collision is vanishingly unlikely, but "a variation produces a different
    waveform hash" is a stated acceptance criterion, and a duplicate seed would
    break it in a way nobody could ever reproduce. One loop is cheaper than
    that conversation.
    """
    seed = new_seed()
    while previous is not None and seed == previous:
        seed = new_seed()
    return seed


def compose_refined_prompt(base: str, delta: str) -> str:
    """
    Fold a refinement instruction into the parent's prompt. Deterministically.

    Design §4.2.3 routes refine_fresh through the Conversation module's
    mutate_prompt(). Conversation is CUT (launch-plan §1.2), and adding a
    Bedrock call here would put a new external dependency, a new failure mode
    and new latency on the submit path — for a feature the plan already
    descoped. This is the seam Bedrock replaces when conversation ships; the
    signature does not move.

    The truncation respects GenerationParams.prompt's 2000-character bound, so
    a long chain of refinements degrades by dropping the tail rather than by
    failing validation.
    """
    base = base.rstrip().rstrip(".")
    return f"{base}. {delta.strip()}"[:2000]


class GenerationService:

    def __init__(
        self,
        track_writer: TrackWriter | None = None,
        track_reader: TrackReader | None = None,
    ) -> None:
        # Injected at the composition root (main.py), not imported: generation
        # must not import catalog. Optional so the singleton below can be
        # constructed at import time and bound afterwards; create_app() always
        # binds both, and using one unbound raises rather than silently
        # producing a job with no track or a variation of nothing.
        self.track_writer = track_writer
        self.track_reader = track_reader

    async def load_parent_track(
        self, *, track_id: UUID, user_id: UUID
    ) -> ParentTrack | None:
        """
        The parent a variation or refine derives from, or None.

        None covers both "no such track" and "not yours" — the route turns
        either into a 404, because a 403 tells an attacker the track exists.
        """
        if self.track_reader is None:
            raise RuntimeError(
                "track_reader is not bound — create_app() must inject it "
                "before variation or refine can resolve a parent track"
            )
        return await self.track_reader.get_track_for_generation(
            track_id=track_id, user_id=user_id
        )

    async def submit(
        self,
        *,
        user_id: UUID,
        kind: JobKind,
        params: GenerationParams,
        parent_track_id: UUID | None = None,
        rate_limit: int | None = None,
    ) -> tuple[UUID, datetime]:
        """
        Insert a QUEUED job and enqueue it for the worker.

        Returns (job_id, created_at) — the route needs created_at for the 202
        body, and reading it back from the INSERT costs nothing.

        `rate_limit` is what makes this both the public and the dev path. When
        None the insert is unconditional, which is what dev-enqueue uses to
        drive Gate C without burning a user's daily budget. When set, the count
        check is folded INTO the insert (§B2) so there is no read-then-write
        window; zero rows back means rate-limited and raises RateLimitedError.

        Deliberately not two methods: duplicating this SQL is how the public
        and dev paths quietly drift apart.
        """
        job_id = UUID(str(uuid7()))
        payload = params.model_dump(mode="json")

        # Commit the row BEFORE enqueuing. A committed row with no SQS message
        # is a recoverable stuck job (the sweeper fails it, the user retries);
        # an SQS message with no row is a worker that claims nothing, logs
        # job_already_claimed, deletes the message, and loses the job forever.
        async with get_session("generation") as session:
            created_at = await self._insert_job(
                session,
                job_id=job_id,
                user_id=user_id,
                kind=kind,
                payload=payload,
                parent_track_id=parent_track_id,
                rate_limit=rate_limit,
            )

        envelope: dict[str, Any] = {
            "schema_version": SQS_SCHEMA_VERSION,
            "job_id": str(job_id),
            "user_id": str(user_id),
            "kind": kind,
            "params": payload,
            "audio_reference_url": None,
            "parent_track_id": (
                str(parent_track_id) if parent_track_id else None
            ),
            "callback_topic_arn": _settings.sns_completions_topic_arn,
            "submitted_at": datetime.now(UTC).isoformat(),
        }
        try:
            await send_sqs_message(
                queue_url=_settings.sqs_jobs_queue_url,
                body=json.dumps(envelope),
                attributes={
                    "job_id": {"DataType": "String", "StringValue": str(job_id)}
                },
            )
        except Exception as exc:
            # The row is committed but nothing will ever pick it up. Fail it
            # here so the user's stream resolves in seconds rather than waiting
            # out the sweeper's 30 minutes. The sweeper is still the backstop
            # for the case where even this write fails.
            logger.exception("enqueue_failed", job_id=str(job_id))
            await self._fail_job(
                job_id, "could not be scheduled — please try again"
            )
            raise EnqueueFailedError(str(job_id)) from exc

        logger.info("job_submitted", job_id=str(job_id), kind=kind)
        return job_id, created_at

    async def _insert_job(
        self,
        session: AsyncSession,
        *,
        job_id: UUID,
        user_id: UUID,
        kind: JobKind,
        payload: dict[str, Any],
        parent_track_id: UUID | None,
        rate_limit: int | None,
    ) -> datetime:
        """
        The one INSERT, with the rate check folded in when there is one.

        The CAST(:param AS type) wrappers are not decoration: asyncpg cannot
        infer a type for a NULL parameter and raises "could not determine data
        type of parameter". parent_track_id is NULL for every `generate`, so it
        genuinely needs one; the rest are cast for consistency.
        """
        params: dict[str, Any] = {
            "id": str(job_id),
            "user_id": str(user_id),
            "kind": kind,
            "payload": json.dumps(payload),
            "parent_track_id": (
                str(parent_track_id) if parent_track_id else None
            ),
        }

        if rate_limit is None:
            statement = """
                INSERT INTO generation.jobs
                    (id, user_id, kind, status, request_payload,
                     parent_track_id, created_at)
                VALUES
                    (CAST(:id AS uuid), CAST(:user_id AS uuid), :kind, 'QUEUED',
                     CAST(:payload AS jsonb), CAST(:parent_track_id AS uuid),
                     now())
                RETURNING created_at
                """
        else:
            # One statement, so there is no window between counting and
            # inserting. Two concurrent requests CAN still both observe 19
            # under READ COMMITTED and both insert — at 20/day with a single
            # API task that is not worth solving, and the honest fix is
            # pg_advisory_xact_lock(hashtext(user_id::text)), which is a
            # Phase-2 line. Written down here so nobody "discovers" it later
            # and panics.
            params["limit"] = rate_limit
            statement = """
                INSERT INTO generation.jobs
                    (id, user_id, kind, status, request_payload,
                     parent_track_id, created_at)
                SELECT CAST(:id AS uuid), CAST(:user_id AS uuid), :kind,
                       'QUEUED', CAST(:payload AS jsonb),
                       CAST(:parent_track_id AS uuid), now()
                WHERE (
                    SELECT count(*) FROM generation.jobs
                     WHERE user_id = CAST(:user_id AS uuid)
                       AND created_at > now() - interval '24 hours'
                       AND status IN ('QUEUED', 'RUNNING', 'COMPLETED')
                ) < :limit
                RETURNING created_at
                """

        row = (await session.execute(text(statement), params)).first()

        if row is None and rate_limit is not None:
            # Zero rows from the CONDITIONAL insert means, and can only mean,
            # that the count predicate was false. Only then are the two extra
            # queries for the 429 body worth running.
            raise RateLimitedError(
                used=await self._used_in_window(session, user_id),
                limit=rate_limit,
                retry_after_seconds=await self._retry_after(session, user_id),
            )
        if row is None:
            # An unconditional INSERT ... RETURNING always yields a row against
            # a real database. The row is committed either way and created_at
            # only decorates the 202 body, so approximating it is far better
            # than failing a request whose job was actually accepted.
            return datetime.now(UTC)
        return cast(datetime, row.created_at)

    async def _used_in_window(
        self, session: AsyncSession, user_id: UUID
    ) -> int:
        result = (
            await session.execute(
                text(RATE_WINDOW_COUNT_SQL), {"user_id": str(user_id)}
            )
        ).first()
        return int(result[0]) if result else 0

    async def _retry_after(
        self, session: AsyncSession, user_id: UUID
    ) -> int:
        """
        Seconds until the oldest job in the window falls out of it.

        Only runs on the rate-limited path, which is why it is a second query
        rather than something the INSERT carries.
        """
        row = (
            await session.execute(
                text(
                    """
                    SELECT created_at FROM generation.jobs
                     WHERE user_id = CAST(:user_id AS uuid)
                       AND created_at > now() - interval '24 hours'
                       AND status IN ('QUEUED', 'RUNNING', 'COMPLETED')
                     ORDER BY created_at ASC
                     LIMIT 1
                    """
                ),
                {"user_id": str(user_id)},
            )
        ).first()
        if row is None:
            return 1
        oldest = cast(datetime, row.created_at)
        if oldest.tzinfo is None:
            oldest = oldest.replace(tzinfo=UTC)
        expires = oldest + timedelta(hours=24)
        return max(1, ceil((expires - datetime.now(UTC)).total_seconds()))

    async def _fail_job(self, job_id: UUID, error: str) -> None:
        """
        Mark a job FAILED without publishing SSE.

        Used by the enqueue-failure path, where the caller is about to raise
        and the HTTP response carries the bad news — no client is streaming yet.
        """
        async with get_session("generation") as session:
            await session.execute(
                text(
                    """
                    UPDATE generation.jobs
                       SET status = 'FAILED', error = :error,
                           completed_at = now()
                     WHERE id = CAST(:id AS uuid)
                       AND status NOT IN
                           ('COMPLETED', 'FAILED', 'DEAD_LETTERED')
                    """
                ),
                {"id": str(job_id), "error": error},
            )

    async def load_job_event(self, job_id: str) -> SSEEvent | None:
        """
        Current state of a job as an SSE event, read from generation.jobs.

        Returns None when the row does not exist — which happens legitimately
        when a client connects before the INSERT commits. The stream's
        keepalive loop covers that gap.
        """
        async with get_session("generation") as session:
            result = await session.execute(
                text(
                    f"SELECT {JOB_COLUMNS} FROM generation.jobs "  # noqa: S608
                    "WHERE id = :id"
                ),
                {"id": job_id},
            )
            row = result.mappings().first()

        if row is None:
            return None
        return _job_to_event(JobRow.from_row(row))

    async def load_job_status(
        self, *, job_id: UUID, user_id: UUID
    ) -> JobStatusRow | None:
        """
        Owner-scoped status of one job, for the client polling fallback.

        Returns None for an unknown id AND for another user's job — the route
        answers both with 404. A 403 would confirm the id exists, which is an
        ownership oracle you get nothing for.

        The LEFT JOIN reaches catalog.tracks on the GENERATION connection, which
        is legal precisely because it touches only (id, source_job_id):
        rithm_generation holds column-scoped SELECT on exactly those two
        (catalog migration 0002). Widen this projection by one column and it
        fails with a permission error at runtime, not at import.

        Note there is no `deleted_at IS NULL` filter — no grant on that column,
        and none is wanted here. This reports what the job produced; whether the
        track is still in the user's library is catalog's question to answer.
        """
        async with get_session("generation") as session:
            result = await session.execute(
                text(
                    """
                    SELECT j.id, j.status, j.kind, j.created_at, j.started_at,
                           j.completed_at, j.error, j.s3_mp3_key,
                           t.id AS track_id
                      FROM generation.jobs j
                      LEFT JOIN catalog.tracks t
                             ON t.source_job_id = j.id
                     WHERE j.id = CAST(:job_id AS uuid)
                       AND j.user_id = CAST(:user_id AS uuid)
                    """
                ),
                {"job_id": str(job_id), "user_id": str(user_id)},
            )
            row = result.mappings().first()

        return None if row is None else JobStatusRow.from_row(row)

    async def finalize_job(
        self,
        *,
        hub: SSEHub,
        job_id: UUID,
        status: str,
        s3_wav_key: str | None = None,
        s3_mp3_key: str | None = None,
        duration_seconds: int | None = None,
        waveform_hash: str | None = None,
        worker_id: str | None = None,
        error: str | None = None,
    ) -> None:
        """
        Move a job to a terminal state, write its track, and publish the
        matching SSE event.

        On success three writes must be all-or-nothing: generation.jobs →
        COMPLETED, catalog.tracks, catalog.prompt_history. They all run on this
        session, which belongs to the generation engine and authenticates as
        rithm_generation — migration 0002_catalog_generation_grants gives that
        role the narrow cross-schema INSERT it needs. The commit happens when
        the context manager exits, so a failure anywhere rolls back all three.

        Only transitions a job that is NOT already terminal. That guard is the
        API-side half of not double-emitting on a duplicate SNS delivery (the
        worker's claim UPDATE is the other half): a replay matches zero rows, so
        there is no second track and no second SSE frame. An unknown job_id is
        logged and ignored — the caller still returns 200, because a 5xx on a
        valid-but-unactionable message means SNS retry → DLQ → a page about
        nothing.
        """
        created: CreatedTrack | None = None

        async with get_session("generation") as session:
            result = await session.execute(
                text(
                    """
                    UPDATE generation.jobs SET
                        status           = :status,
                        worker_id        = COALESCE(:worker_id, worker_id),
                        s3_wav_key       = COALESCE(:s3_wav_key, s3_wav_key),
                        s3_mp3_key       = COALESCE(:s3_mp3_key, s3_mp3_key),
                        duration_seconds = COALESCE(:duration_seconds,
                                                    duration_seconds),
                        waveform_hash    = COALESCE(:waveform_hash,
                                                    waveform_hash),
                        error            = COALESCE(:error, error),
                        completed_at     = now()
                    WHERE id = :job_id
                      AND status NOT IN ('COMPLETED', 'FAILED', 'DEAD_LETTERED')
                    RETURNING user_id, kind, request_payload
                    """
                ),
                {
                    "status": status,
                    "worker_id": worker_id,
                    "s3_wav_key": s3_wav_key,
                    "s3_mp3_key": s3_mp3_key,
                    "duration_seconds": duration_seconds,
                    "waveform_hash": waveform_hash,
                    "error": error,
                    "job_id": str(job_id),
                },
            )
            updated = result.first()

            if updated is None:
                existing = (
                    await session.execute(
                        text(
                            "SELECT status FROM generation.jobs WHERE id = :id"
                        ),
                        {"id": str(job_id)},
                    )
                ).first()
                if existing is None:
                    logger.warning(
                        "finalize_job_unknown_id", job_id=str(job_id)
                    )
                else:
                    logger.info(
                        "finalize_job_already_terminal",
                        job_id=str(job_id),
                        status=existing[0],
                    )
                return

            if status == JobStatus.COMPLETED:
                created = await self._write_track(
                    session,
                    job_id=job_id,
                    row=updated,
                    s3_wav_key=s3_wav_key,
                    s3_mp3_key=s3_mp3_key,
                    waveform_hash=waveform_hash,
                )
            # Commit happens here, on context exit — all three writes together.

        # Everything below runs only AFTER the commit. Publishing inside the
        # block would let a rolled-back transaction emit a `completed` frame
        # for a track that does not exist.
        if status == JobStatus.COMPLETED:
            event: SSEEvent = {
                "event": "completed",
                "data": {
                    "job_id": str(job_id),
                    "s3_mp3_key": s3_mp3_key,
                    "s3_wav_key": s3_wav_key,
                    "duration_seconds": duration_seconds,
                    "track_id": (
                        str(created["track_id"]) if created else None
                    ),
                    "mp3_url": (
                        presign_get(s3_mp3_key, expires=_MP3_URL_TTL_SECONDS)
                        if s3_mp3_key
                        else None
                    ),
                },
            }
        else:
            event = {
                "event": "failed",
                "data": {"job_id": str(job_id), "error": error},
            }

        hub.publish(str(job_id), event)
        logger.info(
            "job_finalized", job_id=str(job_id), status=status
        )

    async def _write_track(
        self,
        session: AsyncSession,
        *,
        job_id: UUID,
        row: Row[Any],
        s3_wav_key: str | None,
        s3_mp3_key: str | None,
        waveform_hash: str | None,
    ) -> CreatedTrack:
        """
        Hand the open transaction to catalog so it can insert the track.

        Raises when the writer is unbound or the envelope is missing the keys
        the track requires. Raising is the right failure mode: the transaction
        rolls back, the job stays non-terminal, and SNS redelivers — versus
        silently committing a COMPLETED job that no track will ever point at.
        """
        if self.track_writer is None:
            raise RuntimeError(
                "track_writer is not bound — create_app() must inject it "
                "before finalize_job can complete a job"
            )
        if not s3_wav_key or not s3_mp3_key or not waveform_hash:
            raise ValueError(
                f"COMPLETED envelope for job {job_id} is missing "
                "s3_wav_key/s3_mp3_key/waveform_hash"
            )

        params = _decode_payload(row.request_payload)
        return await self.track_writer.create_track_in_txn(
            session,
            user_id=UUID(str(row.user_id)),
            source_job_id=job_id,
            kind=str(row.kind),
            prompt=str(params.get("prompt", "")),
            params=params,
            s3_wav_key=s3_wav_key,
            s3_mp3_key=s3_mp3_key,
            waveform_hash=waveform_hash,
            # Already in hand from the UPDATE's RETURNING — no new column, no
            # new query, no migration. NULL for an initial prompt, populated
            # for a refinement, which is exactly what the column is for.
            delta_command=params.get("delta_command"),
        )

    async def sweep_stuck_jobs(self, hub: SSEHub) -> int:
        """
        Fail jobs that will never reach a terminal state on their own. One tick.

        Two sweeps, and the QUEUED one is the half the design doc omits and the
        one that saves you: a job whose SQS send failed, or whose message aged
        out, sits QUEUED forever while the user's SSE stream hangs until their
        browser gives up.

        stuck_queued_seconds must comfortably exceed cold start + queue wait +
        max generation. Cold start with a 12 GB image is 4-6 minutes, so the
        1800s default is a FLOOR, not a suggestion — set it lower and you fail
        perfectly healthy jobs while the ASG is still booting, a bug that only
        appears in production and only under scale-from-zero.

        Returns the number of jobs failed, for the caller's log line.
        """
        settings = get_settings()
        failed: list[tuple[str, str]] = []

        async with get_session("generation") as session:
            for status, seconds, message in (
                (
                    "RUNNING",
                    settings.stuck_running_seconds,
                    "generation timed out — please try again",
                ),
                (
                    "QUEUED",
                    settings.stuck_queued_seconds,
                    "generation could not be scheduled — please try again",
                ),
            ):
                # UPDATE ... RETURNING is atomic, so two API tasks cannot
                # double-fail the same job. Same guard finalize_job uses; do
                # not invent a different one.
                column = "started_at" if status == "RUNNING" else "created_at"
                rows = (
                    await session.execute(
                        text(
                            f"""
                            UPDATE generation.jobs
                               SET status = 'FAILED', error = :error,
                                   completed_at = now()
                             WHERE status = '{status}'
                               AND {column} <
                                   now() - make_interval(secs => :secs)
                            RETURNING id
                            """  # noqa: S608 — both interpolations are literals
                        ),
                        {"error": message, "secs": seconds},
                    )
                ).all()
                failed.extend((str(row.id), message) for row in rows)

        # After the commit, for the same reason finalize_job publishes late.
        for job_id, message in failed:
            hub.publish(
                job_id,
                {
                    "event": "failed",
                    "data": {"job_id": job_id, "error": message},
                },
            )

        if failed:
            logger.warning("sweeper_failed_jobs", count=len(failed))
        return len(failed)

    async def run_sweeper(self, hub: SSEHub) -> None:
        """
        The sweeper loop. Started in lifespan, cancelled on shutdown.

        Ticks every _SWEEPER_TICK_SECONDS but only sweeps every
        sweeper_interval_seconds. The short tick is so CancelledError on
        shutdown is handled promptly, NOT so we sweep more often.

        Every tick is wrapped in try/except: a sweeper that kills the event
        loop on one bad DB moment takes the whole API down with it. This must
        be the most boring, most survivable code in the repo.

        Known deferred risk, already accepted: this publishes into THIS task's
        in-process hub. With desiredCount=1 that is every client. Same
        multi-task limitation Day 2 recorded — do not try to fix it here.
        """
        interval = get_settings().sweeper_interval_seconds
        elapsed = float(interval)  # sweep once promptly on startup
        while True:
            try:
                await asyncio.sleep(_SWEEPER_TICK_SECONDS)
                elapsed += _SWEEPER_TICK_SECONDS
                if elapsed < interval:
                    continue
                elapsed = 0.0
                await self.sweep_stuck_jobs(hub)
            except asyncio.CancelledError:
                logger.info("sweeper_stopped")
                raise
            except Exception:
                logger.exception("sweeper_tick_failed")


def _decode_payload(value: object) -> dict[str, Any]:
    """
    request_payload as a dict, whichever way the driver hands it over.

    SQLAlchemy's asyncpg dialect registers a JSONB codec, so this normally
    arrives already decoded. Accepting a str too keeps the function honest
    against a driver/codec change and against the test double, which replays
    whatever the test scripted.
    """
    if isinstance(value, str):
        value = json.loads(value)
    if isinstance(value, dict):
        return cast(dict[str, Any], value)
    return {}


def _job_to_event(job: JobRow) -> SSEEvent:
    """Map a job row's status onto its SSE event (§2.3)."""
    if job.status == JobStatus.COMPLETED:
        return {
            "event": "completed",
            "data": {
                "job_id": str(job.id),
                "s3_mp3_key": job.s3_mp3_key,
                "s3_wav_key": job.s3_wav_key,
                "duration_seconds": job.duration_seconds,
            },
        }
    if job.status in (JobStatus.FAILED, JobStatus.DEAD_LETTERED):
        return {
            "event": "failed",
            "data": {"job_id": str(job.id), "error": job.error},
        }
    if job.status == JobStatus.RUNNING:
        return {
            "event": "running",
            "data": {
                "job_id": str(job.id),
                "started_at": (
                    job.started_at.isoformat() if job.started_at else None
                ),
            },
        }
    # estimated_start_seconds is the cheapest possible cold-start UX: the risk
    # register calls out "cold start reads as hung", and this lets the SPA say
    # "this may take a few minutes" instead of showing a dead spinner. It is a
    # static number from Gate D, deliberately NOT an ecs:DescribeServices call
    # — that would need a new IAM policy on the API task role and a network hop
    # on the submit path, for a Day-5 concern. 90% of the value, 0% of the risk.
    return {
        "event": "queued",
        "data": {
            "job_id": str(job.id),
            "estimated_start_seconds": (
                get_settings().estimated_cold_start_seconds
            ),
        },
    }


# Module-level singleton, matching identity/service.py.
generation_service = GenerationService()
