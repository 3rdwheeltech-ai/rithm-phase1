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
import json
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

import structlog
from sqlalchemy import Row, text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid_utils import uuid7

from app.config import get_settings
from app.modules.generation.interfaces import CreatedTrack, TrackWriter
from app.modules.generation.models import (
    JOB_COLUMNS,
    JobKind,
    JobRow,
    JobStatus,
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


class GenerationService:

    def __init__(self, track_writer: TrackWriter | None = None) -> None:
        # Injected at the composition root (main.py), not imported: generation
        # must not import catalog. Optional so the singleton below can be
        # constructed at import time and bound afterwards; create_app() always
        # binds it, and a COMPLETED finalize without it raises rather than
        # silently producing a job with no track.
        self.track_writer = track_writer

    async def submit(
        self, *, user_id: UUID, kind: JobKind, params: GenerationParams
    ) -> UUID:
        """
        Insert a QUEUED job and enqueue it for the worker. Returns the job id.

        Intentionally has NO rate limiter — the Day-3 public route wraps this
        with rate_limiter.check(user_id) before calling it, which keeps
        dev-enqueue free to drive Gate C.
        """
        job_id = UUID(str(uuid7()))
        payload = params.model_dump(mode="json")

        # Commit the row BEFORE enqueuing. A committed row with no SQS message
        # is a recoverable stuck job; an SQS message with no row is a worker
        # DLQ event and a 3 a.m. page.
        async with get_session("generation") as session:
            await session.execute(
                text(
                    """
                    INSERT INTO generation.jobs
                        (id, user_id, kind, status, request_payload, created_at)
                    VALUES
                        (:id, :user_id, :kind, 'QUEUED',
                         CAST(:payload AS JSONB), now())
                    """
                ),
                {
                    "id": str(job_id),
                    "user_id": str(user_id),
                    "kind": kind,
                    "payload": json.dumps(payload),
                },
            )

        envelope: dict[str, Any] = {
            "schema_version": SQS_SCHEMA_VERSION,
            "job_id": str(job_id),
            "user_id": str(user_id),
            "kind": kind,
            "params": payload,
            "audio_reference_url": None,
            "parent_track_id": None,
            "callback_topic_arn": _settings.sns_completions_topic_arn,
            "submitted_at": datetime.now(UTC).isoformat(),
        }
        await send_sqs_message(
            queue_url=_settings.sqs_jobs_queue_url,
            body=json.dumps(envelope),
            attributes={
                "job_id": {"DataType": "String", "StringValue": str(job_id)}
            },
        )
        logger.info("job_submitted", job_id=str(job_id), kind=kind)
        return job_id

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
        )


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
    return {"event": "queued", "data": {"job_id": str(job.id)}}


# Module-level singleton, matching identity/service.py.
generation_service = GenerationService()
