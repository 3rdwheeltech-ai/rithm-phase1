"""
SQS wrappers.

Long-poll and visibility are set at receive time as well as on the queue
(ops/scripts/init-localstack.sh provisions VisibilityTimeout=300,
maxReceiveCount=3). Belt and braces on purpose: the queue attributes are
infrastructure that can drift, these are code that ships with the consumer.
"""
from typing import Any

import structlog

from worker import aws
from worker.config import get_settings

logger = structlog.get_logger()

# 20s is the SQS maximum. Long-polling is what keeps an idle worker from
# burning a ReceiveMessage call every few milliseconds.
_WAIT_TIME_SECONDS = 20
# 300s must exceed the slowest job. A stub job is ~15s; a real 180s generation
# on an L4 is the number Day-3's PoC will confirm this against.
_VISIBILITY_TIMEOUT_SECONDS = 300


def receive_one() -> dict[str, Any] | None:
    """One message, or None after the long-poll expires."""
    response = aws.sqs().receive_message(
        QueueUrl=get_settings().sqs_jobs_queue_url,
        MaxNumberOfMessages=1,
        WaitTimeSeconds=_WAIT_TIME_SECONDS,
        VisibilityTimeout=_VISIBILITY_TIMEOUT_SECONDS,
        MessageAttributeNames=["All"],
    )
    messages: list[dict[str, Any]] = response.get("Messages", [])
    return messages[0] if messages else None


def delete(receipt_handle: str) -> None:
    """Remove a message for good. Only after the job reached a terminal state."""
    aws.sqs().delete_message(
        QueueUrl=get_settings().sqs_jobs_queue_url,
        ReceiptHandle=receipt_handle,
    )


def release(receipt_handle: str) -> None:
    """
    Hand a message straight back to the queue.

    Spot-interruption path only. A retryable failure deliberately does NOT call
    this — it just declines to delete, and lets the 300s visibility lapse, which
    spaces out retries instead of hot-looping a failing dependency.
    """
    aws.sqs().change_message_visibility(
        QueueUrl=get_settings().sqs_jobs_queue_url,
        ReceiptHandle=receipt_handle,
        VisibilityTimeout=0,
    )
