"""
The API's AWS SDK surface.

Direction is a contract, not a convenience: the API is an SQS *producer only*
(SendMessage, never ReceiveMessage — IAM forbids it and the Day-2 worker is the
sole consumer), and it never publishes to SNS. Keeping every SDK call behind
this module's typed functions is what makes that reviewable.

boto3 (sync) + run_in_threadpool matches the precedent in identity/service.py.
The alternative, an aioboto3 client cached on app.state, would have to be built
in lifespan — and the test suite's async_client fixture never runs lifespan, so
it would be invisible to most tests. One SendMessage per request makes the
threadpool hop irrelevant.
"""
# boto3/botocore ship no py.typed, so every call is Unknown to pyright strict.
# Containing the suppression to this one file is the whole point of the module;
# the public functions below have fully concrete signatures, so nothing leaks.
# pyright: reportMissingTypeStubs=false, reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false
from typing import Any

import boto3
import structlog
from fastapi.concurrency import run_in_threadpool

from app.config import get_settings

logger = structlog.get_logger()

_sqs_client: Any = None


def _sqs() -> Any:
    """
    Lazily build the SQS client.

    Lazy, not import-time, so tests can patch settings (or this module) before
    the first call, and so importing app.main never reaches out to AWS.
    """
    global _sqs_client
    if _sqs_client is None:
        settings = get_settings()
        kwargs: dict[str, Any] = {"region_name": settings.aws_region}
        if settings.aws_endpoint_url:
            # LocalStack. Unset in prod → real AWS endpoints.
            kwargs["endpoint_url"] = settings.aws_endpoint_url
        _sqs_client = boto3.client("sqs", **kwargs)
    return _sqs_client


def reset_clients() -> None:
    """Drop cached clients. Test helper — not used at runtime."""
    global _sqs_client
    _sqs_client = None


async def send_sqs_message(
    *,
    queue_url: str,
    body: str,
    attributes: dict[str, dict[str, str]] | None = None,
) -> str:
    """Send one message to SQS. Returns the SQS MessageId."""
    kwargs: dict[str, Any] = {"QueueUrl": queue_url, "MessageBody": body}
    if attributes:
        kwargs["MessageAttributes"] = attributes
    response = await run_in_threadpool(_sqs().send_message, **kwargs)
    message_id = str(response["MessageId"])
    logger.info("sqs_message_sent", message_id=message_id)
    return message_id
