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


def receive_one() -> dict[str, Any] | None:
    """
    One message, or None after the long-poll expires.

    VisibilityTimeout comes from settings, not a constant: the queue's own
    default is 300s, and a real generation can exceed that. When it does, SQS
    redelivers a job that is STILL RUNNING. The claim guard makes the second
    delivery harmless, but it burns one of the three receives — and three of
    those send a perfectly healthy job to the DLQ. The receive-level value
    overrides the queue attribute, which is why setting it here is enough.
    """
    response = aws.sqs().receive_message(
        QueueUrl=get_settings().sqs_jobs_queue_url,
        MaxNumberOfMessages=1,
        WaitTimeSeconds=_WAIT_TIME_SECONDS,
        VisibilityTimeout=get_settings().sqs_visibility_timeout_seconds,
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
    this — it just declines to delete, and lets the visibility window lapse,
    which spaces out retries instead of hot-looping a failing dependency.
    """
    aws.sqs().change_message_visibility(
        QueueUrl=get_settings().sqs_jobs_queue_url,
        ReceiptHandle=receipt_handle,
        VisibilityTimeout=0,
    )
