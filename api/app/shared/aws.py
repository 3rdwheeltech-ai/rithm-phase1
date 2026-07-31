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
_s3_client: Any = None


def _client(service: str) -> Any:
    settings = get_settings()
    kwargs: dict[str, Any] = {"region_name": settings.aws_region}
    if settings.aws_endpoint_url:
        # LocalStack. Unset in prod → real AWS endpoints.
        kwargs["endpoint_url"] = settings.aws_endpoint_url
    return boto3.client(service, **kwargs)


def _sqs() -> Any:
    """
    Lazily build the SQS client.

    Lazy, not import-time, so tests can patch settings (or this module) before
    the first call, and so importing app.main never reaches out to AWS.
    """
    global _sqs_client
    if _sqs_client is None:
        _sqs_client = _client("sqs")
    return _sqs_client


def _s3() -> Any:
    """Lazily build the S3 client. Same reasoning as _sqs()."""
    global _s3_client
    if _s3_client is None:
        _s3_client = _client("s3")
    return _s3_client


def reset_clients() -> None:
    """Drop cached clients. Test helper — not used at runtime."""
    global _sqs_client, _s3_client
    _sqs_client = None
    _s3_client = None


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


def presign_get(key: str, expires: int = 900) -> str:
    """
    Presigned GET URL for an object in the assets bucket.

    Synchronous with no threadpool hop because presigning is pure local
    signing — no network call, nothing to await. It succeeds regardless of
    whether the object exists; authorisation is checked when the URL is used.

    This is the launch stand-in for CloudFront signed URLs (launch plan §2.1).
    Swapping to CloudFront later replaces this function body and nothing else —
    mp3_url stays a plain string on the wire.
    """
    settings = get_settings()
    url = _s3().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.assets_bucket, "Key": key},
        ExpiresIn=expires,
    )
    return str(url)
