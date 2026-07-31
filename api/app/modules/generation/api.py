"""
Generation HTTP surface.

Three routers with different mounting rules (see main.py):
  router           → mounted under /api/v1 (public, token-authenticated stream)
  internal_router  → mounted at the ROOT. The SNS subscription URL and the ALB
                     rule both hardcode /internal/sns/job-completion; adding a
                     prefix silently breaks the subscription.
  dev_router       → mounted at the root, and only when settings
                     .rithm_dev_endpoints is true.

The public POST /tracks/generate|variation|refine routes are Day 3 and are
deliberately absent — opening a GPU write path before the rate limiter exists
is how you wake up to a budget alarm.
"""
import asyncio
import json
from collections.abc import AsyncIterator
from typing import Annotated, Any
from uuid import UUID

import httpx
import structlog
from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse

from app.config import get_settings
from app.modules.generation.schemas import (
    DevEnqueueRequest,
    DevEnqueueResponse,
    GenerationParams,
    SSEEvent,
)
from app.modules.generation.service import generation_service
from app.modules.generation.sse_hub import SSEHub
from app.modules.generation.sse_token import SSETokenError, mint, verify
from app.shared.sns_verify import SNSVerificationError, verify_sns_signature

logger = structlog.get_logger()
_settings = get_settings()

router = APIRouter(tags=["generation"])
internal_router = APIRouter(tags=["internal"], include_in_schema=False)
dev_router = APIRouter(tags=["dev"], include_in_schema=False)

# Module constants so tests can shorten them without sleeping for real.
# 15s heartbeat sits comfortably under the ALB's 120s idle timeout.
_HEARTBEAT_SECONDS = 15.0
# Hard ceiling on one stream. A job that never finalizes must not leak a task
# forever; the client reconnects with the same token and replays from the DB.
_MAX_STREAM_SECONDS = 900.0

_TERMINAL_EVENTS = ("completed", "failed")

# Documented fixed dev user. No identity.users row is needed — cross-schema
# FKs in this design are logical, not enforced.
SYNTHETIC_USER_ID = UUID("00000000-0000-7000-8000-000000000001")


def _frame(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _event_stream(hub: SSEHub, job_id: str) -> AsyncIterator[str]:
    """
    Ordering is load-bearing: subscribe FIRST, then read the DB, then drain.

    Reading before subscribing loses a completion published in the gap between
    the two — the classic lost-wakeup, and it shows up as a stream that hangs
    on a job that finished a millisecond earlier.

    Takes the hub rather than the Request so it can be driven directly in
    tests: neither httpx's ASGITransport nor Starlette's TestClient can observe
    a stream incrementally — both buffer the whole body.
    """
    queue = hub.subscribe(job_id)
    deadline = asyncio.get_running_loop().time() + _MAX_STREAM_SECONDS
    try:
        state: SSEEvent | None = await generation_service.load_job_event(job_id)
        if state is not None:
            yield _frame(state["event"], state["data"])
            if state["event"] in _TERMINAL_EVENTS:
                # Terminal in the DB → replay and close. Don't wait for an
                # event that already happened.
                return

        while asyncio.get_running_loop().time() < deadline:
            try:
                event = await asyncio.wait_for(
                    queue.get(), timeout=_HEARTBEAT_SECONDS
                )
            except TimeoutError:
                yield ": keepalive\n\n"
                continue
            yield _frame(event["event"], event["data"])
            if event["event"] in _TERMINAL_EVENTS:
                return
    finally:
        # Deliberately no `await request.is_disconnected()` in the loop above.
        # Under BaseHTTPMiddleware (which RequestIdMiddleware is) that call
        # runs receive_or_disconnect concurrently with StreamingResponse's own
        # listen_for_disconnect — a second consumer of the same receive
        # channel, whose error path raises RuntimeError. Cleanup is already
        # correct without it: Starlette cancels the task group on
        # http.disconnect, which propagates into this generator and runs this
        # finally.
        hub.unsubscribe(job_id, queue)


@router.get("/jobs/{job_id}/events")
async def job_events(
    job_id: str,
    request: Request,
    token: Annotated[str, Query()],
) -> StreamingResponse:
    """
    Server-sent events for one job. The signed token IS the auth here —
    EventSource cannot send an Authorization header.
    """
    try:
        payload = verify(
            token, _settings.sse_token_secret.get_secret_value()
        )
    except SSETokenError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid or expired token"
        ) from exc

    if payload.get("jid") != job_id:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Token/job mismatch"
        )

    hub: SSEHub = request.app.state.sse_hub
    return StreamingResponse(
        _event_stream(hub, job_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@internal_router.post("/internal/sns/job-completion")
async def on_job_completion(request: Request) -> Response:
    """
    SNS completion webhook. No auth dependency — the signature check IS the
    auth.

    Returns 200 for every message it safely handled or ignored, including an
    unknown job_id. The only non-2xx is a failed signature check. A 5xx on a
    valid-but-unactionable message means SNS retry → DLQ → an alarm about a
    message that was never actionable.
    """
    body = await request.body()
    try:
        envelope: dict[str, Any] = json.loads(body)
    except json.JSONDecodeError:
        logger.warning("sns_body_not_json")
        return Response(status_code=status.HTTP_403_FORBIDDEN)

    try:
        await verify_sns_signature(envelope)
    except SNSVerificationError:
        return Response(status_code=status.HTTP_403_FORBIDDEN)

    msg_type = envelope.get("Type")

    if msg_type == "SubscriptionConfirmation":
        # Confirming is an outbound HTTPS GET — no IAM involved, which is why
        # the API needs no sns:* permission at all.
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.get(str(envelope["SubscribeURL"]))
        logger.info("sns_subscription_confirmed")
        return Response(status_code=status.HTTP_200_OK)

    if msg_type == "Notification":
        try:
            message: dict[str, Any] = json.loads(envelope["Message"])
            await generation_service.finalize_job(
                hub=request.app.state.sse_hub,
                job_id=UUID(str(message["job_id"])),
                status=str(message["status"]),
                s3_wav_key=message.get("s3_wav_key"),
                s3_mp3_key=message.get("s3_mp3_key"),
                duration_seconds=message.get("duration_seconds"),
                waveform_hash=message.get("waveform_hash"),
                worker_id=message.get("worker_id"),
                error=message.get("error"),
            )
        except Exception:  # noqa: BLE001 — log, but still 200. See docstring.
            logger.exception("sns_notification_handling_failed")
        return Response(status_code=status.HTTP_200_OK)

    logger.warning("sns_unknown_type", sns_type=msg_type)
    return Response(status_code=status.HTTP_200_OK)


@dev_router.post(
    "/internal/dev/enqueue-test-job", response_model=DevEnqueueResponse
)
async def enqueue_test_job(body: DevEnqueueRequest) -> DevEnqueueResponse:
    """
    Drive the full write path without an auth flow. Gate C leans on this.

    Mounted only when settings.rithm_dev_endpoints is true — guarded at
    include_router() time, so in prod the route simply does not exist.
    """
    params = body.params or GenerationParams(
        prompt="stub test tone", length_seconds=30
    )
    job_id = await generation_service.submit(
        user_id=SYNTHETIC_USER_ID, kind=body.kind, params=params
    )
    token = mint(
        str(SYNTHETIC_USER_ID),
        str(job_id),
        _settings.sse_token_secret.get_secret_value(),
        _settings.sse_token_ttl_seconds,
    )
    return DevEnqueueResponse(
        job_id=job_id,
        sse_token=token,
        sse_url=f"/api/v1/jobs/{job_id}/events?token={token}",
    )
