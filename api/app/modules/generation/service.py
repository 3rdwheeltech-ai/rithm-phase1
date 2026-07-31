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
from typing import Any
from uuid import UUID

import structlog
from sqlalchemy import text
from uuid_utils import uuid7

from app.config import get_settings
from app.modules.generation.models import (
    JOB_COLUMNS,
    JobKind,
    JobRow,
    JobStatus,
)
from app.modules.generation.schemas import GenerationParams, SSEEvent
from app.modules.generation.sse_hub import SSEHub
from app.shared.aws import send_sqs_message
from app.shared.db import get_session

logger = structlog.get_logger()
_settings = get_settings()

# Bumping this is how the Day-2 worker learns the envelope changed shape; the
# worker DLQs any version it does not recognise.
SQS_SCHEMA_VERSION = 1


class GenerationService:

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
        Move a job to a terminal state and publish the matching SSE event.

        Only transitions a job that is NOT already terminal. That guard is the
        API-side half of not double-emitting on a duplicate SNS delivery (the
        worker's claim UPDATE is the other half). An unknown job_id is logged
        and ignored — the caller still returns 200, because a 5xx on a
        valid-but-unactionable message means SNS retry → DLQ → a page about
        nothing.
        """
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
                    RETURNING id
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

        # TODO(day-2): catalog seam. In the same transaction as the UPDATE
        # above, insert catalog.tracks + the initial catalog.prompt_history row
        # on success, then enrich the `completed` event below with track_id and
        # a presigned mp3_url. Today finalize_job writes only generation.jobs
        # and publishes the job-level event.

        if status == JobStatus.COMPLETED:
            event: SSEEvent = {
                "event": "completed",
                "data": {
                    "job_id": str(job_id),
                    "s3_mp3_key": s3_mp3_key,
                    "s3_wav_key": s3_wav_key,
                    "duration_seconds": duration_seconds,
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
