"""
One job, end to end.

The error taxonomy here is the part worth reading twice, because each branch
decides whether AWS retries and whether the user ever hears about it:

  claim → False    not an error. Delete the message, log `job_already_claimed`,
                   return. This is the redelivery case, and it is normal.
  RetryableError   transient dependency failure. Do NOT delete and do NOT
                   publish. The 300s visibility lapses and SQS redelivers, which
                   spaces retries out instead of hot-looping.
  anything else    permanent. Publish FAILED so the user's stream resolves, then
                   delete. A permanent failure left to redeliver just burns
                   3 receives → DLQ → a 3am alarm about a job that can never
                   succeed.

The message is deleted only AFTER the SNS publish succeeds. Deleting first would
turn an SNS outage into a silently lost job with no row to sweep and no message
to redeliver.
"""
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog

from worker import audio, aws, db, messaging, storage
from worker.inference import run_inference

logger = structlog.get_logger()

# The worker refuses envelopes it does not understand. Bumping this on the API
# side is how a breaking envelope change is signalled.
SQS_SCHEMA_VERSION = 1

_MAX_ERROR_CHARS = 500


class RetryableError(Exception):
    """Transient failure — leave the message for SQS to redeliver."""


def process_job(msg: dict[str, Any], model: Any, worker_id: str) -> None:
    receipt_handle: str = msg["ReceiptHandle"]

    try:
        job: dict[str, Any] = json.loads(msg["Body"])
    except json.JSONDecodeError:
        # Unparseable body: there is no job_id to report against, so there is
        # nothing to publish. Drop it rather than letting it cycle to the DLQ.
        logger.exception("job_body_not_json")
        messaging.delete(receipt_handle)
        return

    # 1. Schema gate. An unknown version is permanent by definition — a newer
    #    envelope will not become readable on retry.
    if job.get("schema_version") != SQS_SCHEMA_VERSION:
        logger.warning(
            "unsupported_schema_version",
            job_id=job.get("job_id"),
            schema_version=job.get("schema_version"),
        )
        _publish_failed(
            job, "unsupported schema_version", "SchemaVersionError", worker_id
        )
        messaging.delete(receipt_handle)
        return

    job_id = str(job["job_id"])
    user_id = str(job["user_id"])

    # 2. The claim. Single source of truth for idempotency.
    try:
        claimed = db.claim_job(job_id, worker_id)
    except Exception as exc:
        # The DB was unreachable, not the job unclaimable. Redeliver.
        logger.warning("claim_failed_retryable", job_id=job_id, error=str(exc))
        return

    if not claimed:
        # Exact string — Gate C6 greps for it.
        logger.info("job_already_claimed", job_id=job_id)
        messaging.delete(receipt_handle)
        return

    # 3. Do the work. Declared up front so the finally block can clean up
    #    whichever intermediates were reached before a failure.
    raw: Path | None = None
    normalized: Path | None = None
    mp3: Path | None = None
    try:
        raw = run_inference(model, job)
        normalized = audio.loudnorm(raw)
        mp3 = audio.encode_mp3(normalized)
        wav_key, mp3_key = storage.upload_track_assets(
            user_id, job_id, normalized, mp3
        )
        _publish_completed(
            job,
            wav_key=wav_key,
            mp3_key=mp3_key,
            duration_seconds=audio.probe_duration_seconds(mp3),
            waveform_hash=audio.waveform_sha256(normalized),
            worker_id=worker_id,
        )
        messaging.delete(receipt_handle)
        logger.info("job_completed", job_id=job_id)
    except RetryableError as exc:
        logger.warning("retryable_failure", job_id=job_id, error=str(exc))
        # No delete, no publish. SQS redelivers after the visibility window.
    except Exception as exc:
        logger.exception("permanent_failure", job_id=job_id)
        _publish_failed(
            job,
            str(exc)[:_MAX_ERROR_CHARS],
            type(exc).__name__,
            worker_id,
        )
        messaging.delete(receipt_handle)
    finally:
        _cleanup(raw, normalized, mp3)


def _cleanup(*paths: Path | None) -> None:
    """
    Best-effort removal of intermediate audio. Never fails a job.

    Without this a long-lived GPU task accumulates one WAV + one MP3 per job in
    /tmp until the task's ephemeral storage fills — which surfaces as unrelated
    ffmpeg failures much later.
    """
    for path in paths:
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("temp_cleanup_failed", path=str(path))


def _publish(job: dict[str, Any], payload: dict[str, Any]) -> None:
    """
    Publish to the topic carried IN THE MESSAGE, never a configured ARN.

    That is what the task role scopes, and it is what lets the same worker image
    run against a different environment's topic with no config change.
    """
    aws.sns().publish(
        TopicArn=job["callback_topic_arn"],
        Message=json.dumps(payload),
    )


def build_completed_envelope(
    job: dict[str, Any],
    *,
    wav_key: str,
    mp3_key: str,
    duration_seconds: int,
    waveform_hash: str,
    worker_id: str,
) -> dict[str, Any]:
    """
    The COMPLETED payload the API's finalize_job reads field-by-field.

    Public and pure so its shape can be asserted without a publish: a rename
    here is a silent break, since the SNS handler would still 200 while the job
    sat at RUNNING until the sweeper failed it.
    """
    return {
        "schema_version": SQS_SCHEMA_VERSION,
        "job_id": str(job["job_id"]),
        "status": "COMPLETED",
        "s3_wav_key": wav_key,
        "s3_mp3_key": mp3_key,
        "duration_seconds": duration_seconds,
        "waveform_hash": waveform_hash,
        "worker_id": worker_id,
        "completed_at": datetime.now(UTC).isoformat(),
    }


def build_failed_envelope(
    job: dict[str, Any], error: str, error_class: str, worker_id: str
) -> dict[str, Any]:
    """The FAILED payload. `error` is capped so a stack trace cannot bloat it."""
    return {
        "schema_version": SQS_SCHEMA_VERSION,
        "job_id": str(job.get("job_id", "")),
        "status": "FAILED",
        "error": error[:_MAX_ERROR_CHARS],
        "error_class": error_class,
        "worker_id": worker_id,
        "failed_at": datetime.now(UTC).isoformat(),
    }


def _publish_completed(
    job: dict[str, Any],
    *,
    wav_key: str,
    mp3_key: str,
    duration_seconds: int,
    waveform_hash: str,
    worker_id: str,
) -> None:
    _publish(
        job,
        build_completed_envelope(
            job,
            wav_key=wav_key,
            mp3_key=mp3_key,
            duration_seconds=duration_seconds,
            waveform_hash=waveform_hash,
            worker_id=worker_id,
        ),
    )


def _publish_failed(
    job: dict[str, Any], error: str, error_class: str, worker_id: str
) -> None:
    _publish(job, build_failed_envelope(job, error, error_class, worker_id))
