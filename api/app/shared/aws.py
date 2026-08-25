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
from enum import StrEnum
from typing import Any, Literal, TypedDict

import boto3
import structlog
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from fastapi.concurrency import run_in_threadpool

from app.config import get_settings

logger = structlog.get_logger()

_sqs_client: Any = None
_s3_client: Any = None
# Keyed by read timeout, NOT a single global: the chat path needs a slower
# client than the authoring path (a conversation turn is a longer generation
# than a title), and botocore settles the timeout at construction time. A dict
# is what lets both live in one process without one silently reconfiguring the
# other.
_bedrock_runtime_clients: dict[int, Any] = {}


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


def _bedrock_client(read_timeout: int = 10) -> Any:
    """
    Lazily build the bedrock-runtime client. Deliberately does NOT honour any
    configured endpoint override.

    LocalStack has no Bedrock. Sending this at :4566 turns a call that is
    supposed to degrade quietly into an error on every single submit — a
    failure mode that appears only locally, which is the worst kind. That is
    why this does not reuse `_client()`.

    `ignore_configured_endpoint_urls` is the load-bearing line, and merely
    omitting `endpoint_url=` is NOT enough: AWS_ENDPOINT_URL is a
    botocore-NATIVE environment variable, applied to every service
    automatically, so docker-compose's `AWS_ENDPOINT_URL: http://localstack:4566`
    reaches this client whether we pass one or not. Verified against
    botocore 1.40: without this flag the resolved endpoint is localstack:4566
    and every Converse returns LocalStack's "unknown operation for service
    bedrock" InternalError. It also covers the same override set in a profile
    or in AWS_ENDPOINT_URL_BEDROCK_RUNTIME.

    One attempt, short timeouts: the caller already has an asyncio timeout and
    a fallback, and botocore's default three retries would blow through both.
    A retry storm, not the price per call, is the thing to watch here.

    `total_max_attempts`, NOT `max_attempts`: botocore reads the latter as a
    retry count and normalises `max_attempts=1` to two total attempts. Two
    attempts at a 10s read timeout is up to 20s of wall clock in front of a
    202 the user is watching a spinner for — and the title call's whole budget
    is 4s, so its retry could never land inside the window anyway. One attempt
    is what the latency budget can afford, so it is what is asked for.

    `read_timeout` DEFAULTS TO 10 and the default is the contract: every caller
    that predates the chat feature calls this with no arguments and expects the
    authoring client. The chat path passes a longer one because a conversation
    turn is a bigger generation than a title, and it must sit comfortably OUTSIDE
    the asyncio budget that governs the turn — botocore cutting in first would
    turn a clean timeout into a ClientError the chain would then misread as a
    structural refusal and advance on.
    """
    client = _bedrock_runtime_clients.get(read_timeout)
    if client is None:
        settings = get_settings()
        client = boto3.client(
            "bedrock-runtime",
            region_name=settings.aws_region,
            config=Config(
                connect_timeout=2,
                read_timeout=read_timeout,
                retries={"total_max_attempts": 1, "mode": "standard"},
                ignore_configured_endpoint_urls=True,
            ),
        )
        _bedrock_runtime_clients[read_timeout] = client
    return client


def reset_clients() -> None:
    """
    Drop cached clients. Test helper — not used at runtime.

    The bedrock cache is CLEARED, not nulled: it is a dict now, and rebinding
    the name would leave the tests' `fresh_clients` autouse fixture silently
    doing nothing — every later test would then assert against a client built
    under an earlier test's environment.
    """
    global _sqs_client, _s3_client
    _sqs_client = None
    _s3_client = None
    _bedrock_runtime_clients.clear()


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


class ConverseMessage(TypedDict):
    """One turn on the Converse wire. `content` is Bedrock's block list."""

    role: Literal["user", "assistant"]
    content: list[dict[str, str]]  # [{"text": ...}]


class ConverseOutcome(StrEnum):
    """
    Why a Converse call produced no text — which the caller sometimes has to
    act on differently.

    A bare `None` conflates "the feature is switched off" with "the model
    refused". That is fine for the authoring calls, which have one
    deterministic fallback either way. It is useless for the chat chain, which
    must choose between running the offline interviewer and trying the next
    model in the list.
    """

    OK = "ok"
    DISABLED = "disabled"  # bedrock_enabled is False — the default, NOT a failure
    FAILED = "failed"  # ClientError / BotoCoreError / malformed response


async def converse_messages(
    *,
    model_id: str,
    system: str,
    messages: list[ConverseMessage],
    max_tokens: int,
    temperature: float,
    read_timeout: int = 10,
) -> tuple[ConverseOutcome, str | None]:
    """
    A multi-turn Bedrock Converse call, plus WHY it produced nothing.

    Converse rather than InvokeModel because it is the one request shape that
    is identical across Anthropic and Amazon models — which is the only reason
    two different providers can share this function.

    Never raises. Every AWS failure, every malformed response and every
    unexpected shape comes back as FAILED, because a Bedrock outage must never
    turn a 202 into a 500 and raising would only move the try/except one frame
    up.
    """
    settings = get_settings()
    if not settings.bedrock_enabled:
        # Not a failure — the default posture. Local, CI and tests take the
        # fallback paths, which is also free coverage of them.
        logger.debug("bedrock_disabled", model_id=model_id)
        return ConverseOutcome.DISABLED, None

    try:
        response = await run_in_threadpool(
            _bedrock_client(read_timeout).converse,
            modelId=model_id,
            system=[{"text": system}],
            messages=messages,
            inferenceConfig={"maxTokens": max_tokens, "temperature": temperature},
        )
        return ConverseOutcome.OK, str(
            response["output"]["message"]["content"][0]["text"]
        )
    except (ClientError, BotoCoreError, KeyError, IndexError, TypeError) as exc:
        # The exception CLASS, never the message: a Bedrock error body can
        # quote the prompt back, and prompts carry user content.
        logger.warning(
            "bedrock_converse_failed", model_id=model_id, error=type(exc).__name__
        )
        return ConverseOutcome.FAILED, None


async def converse(
    *, model_id: str, system: str, user: str, max_tokens: int, temperature: float
) -> str | None:
    """
    One Bedrock Converse turn, or None.

    The single-turn face of `converse_messages`, kept because the authoring
    calls have exactly one deterministic fallback and so have nothing to do
    with the distinction an outcome draws. Returns None on ANY failure: the
    feature switched off, throttling, denied model access, a malformed
    response, a network blip.
    """
    _outcome, text = await converse_messages(
        model_id=model_id,
        system=system,
        messages=[{"role": "user", "content": [{"text": user}]}],
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return text
