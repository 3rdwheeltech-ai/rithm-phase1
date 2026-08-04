"""
Generation HTTP surface.

Three routers with different mounting rules (see main.py):
  router           → mounted under /api/v1 (public, token-authenticated stream)
  internal_router  → mounted at the ROOT. The SNS subscription URL and the ALB
                     rule both hardcode /internal/sns/job-completion; adding a
                     prefix silently breaks the subscription.
  dev_router       → mounted at the root, and only when settings
                     .rithm_dev_endpoints is true.

This module owns the POST verbs under /tracks; catalog owns GET and DELETE.
main.py registers this router FIRST and every path param is typed UUID, so
`/tracks/generate` can never be swallowed by `/tracks/{track_id}` — today they
differ by method anyway, but the ordering makes that true for any future
addition too.

Ownership misses on variation/refine return 404, never 403. A 403 tells an
attacker the track exists.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Annotated, Any
from uuid import UUID

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse

from app.config import get_settings
from app.modules.generation.interfaces import ParentTrack
from app.modules.generation.models import JobKind
from app.modules.generation.schemas import (
    DevEnqueueRequest,
    DevEnqueueResponse,
    GenerateRequest,
    GenerationParams,
    JobAccepted,
    JobStatusResponse,
    RefinementMode,
    RefineRequest,
    SSEEvent,
    resolve_bpm,
)
from app.modules.generation.service import (
    EnqueueFailedError,
    RateLimitedError,
    compose_refined_prompt,
    generation_service,
    new_seed,
    new_seed_distinct_from,
)
from app.modules.generation.sse_hub import SSEHub
from app.modules.generation.sse_token import (
    SSETokenError,
    SSETokenExpired,
    mint,
    verify,
)
from app.shared.auth import require_user
from app.shared.aws import presign_get
from app.shared.exceptions import (
    EnqueueFailedException,
    RateLimitExceededException,
    ResourceNotFoundException,
    SSETokenExpiredException,
    UnsupportedRefinementException,
)
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


# ── Public write surface ───────────────────────────────────────────────────


async def _submit(
    *,
    user_id: UUID,
    kind: JobKind,
    params: GenerationParams,
    parent_track_id: UUID | None = None,
) -> JobAccepted:
    """
    The shared tail of all three write routes.

    Everything above this point has already resolved the job's params — that is
    the whole architectural bet of Day 3 (§B0.1). A variation's params are the
    parent's with a fresh seed; a refine's are the parent's with a composed
    prompt. By the time we get here the three kinds are indistinguishable, and
    the worker never learns they were ever different.
    """
    # Runtime cap on top of the schema's static le=180, so Tri can lower the
    # ceiling from the PoC findings via env without a deploy.
    max_length = _settings.max_length_seconds
    if params.length_seconds > max_length:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"length_seconds must be at most {max_length}.",
        )

    try:
        job_id, created_at = await generation_service.submit(
            user_id=user_id,
            kind=kind,
            params=params,
            parent_track_id=parent_track_id,
            rate_limit=_settings.rate_limit_per_24h,
        )
    except RateLimitedError as exc:
        raise RateLimitExceededException(
            retry_after_seconds=exc.retry_after_seconds,
            used=exc.used,
            limit=exc.limit,
        ) from exc
    except EnqueueFailedError as exc:
        raise EnqueueFailedException() from exc

    token = mint(
        str(user_id),
        str(job_id),
        _settings.sse_token_secret.get_secret_value(),
        _settings.sse_token_ttl_seconds,
    )
    return JobAccepted(
        job_id=job_id,
        status="QUEUED",
        sse_url=f"/api/v1/jobs/{job_id}/events?token={token}",
        created_at=created_at,
    )


async def _parent_or_404(track_id: UUID, user_id: UUID) -> ParentTrack:
    parent = await generation_service.load_parent_track(
        track_id=track_id, user_id=user_id
    )
    if parent is None:
        # Covers "no such track" and "not yours" identically, on purpose.
        raise ResourceNotFoundException("Track", str(track_id))
    return parent


@router.post(
    "/tracks/generate",
    response_model=JobAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def generate_track(
    body: GenerateRequest,
    user_id: UUID = Depends(require_user),
) -> JobAccepted:
    """Submit a new generation (TTM-01 + the GMC-01..05 controls)."""
    params = GenerationParams(
        prompt=body.prompt,
        genre=body.genre,
        mood=body.mood,
        # Both the resolved scalar and the range it came from: the worker
        # conditions on bpm, catalog indexes it, and the Day-4 UI needs the
        # range back to repopulate its slider.
        bpm=resolve_bpm(body.bpm_min, body.bpm_max),
        bpm_min=body.bpm_min,
        bpm_max=body.bpm_max,
        instruments=body.instruments,
        vocal=body.vocal,
        length_seconds=body.length_seconds,
        seed=new_seed(),
    )
    return await _submit(user_id=user_id, kind="generate", params=params)


@router.post(
    "/tracks/{track_id}/variation",
    response_model=JobAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_variation(
    track_id: UUID,
    user_id: UUID = Depends(require_user),
) -> JobAccepted:
    """
    Re-roll a track with the same prompt and a different seed (TTM-04).

    No body: an unchanged prompt is the entire point of a variation. The only
    thing that moves is the seed, and it is guaranteed to differ from the
    parent's — "the variation's waveform_hash differs from its parent's" is an
    acceptance criterion, and a duplicate seed would break it irreproducibly.
    """
    parent = await _parent_or_404(track_id, user_id)
    params = GenerationParams.model_validate(
        {
            **parent["params"],
            "prompt": parent["prompt"],
            "seed": new_seed_distinct_from(parent["params"].get("seed")),
        }
    )
    return await _submit(
        user_id=user_id,
        kind="variation",
        params=params,
        parent_track_id=track_id,
    )


@router.post(
    "/tracks/{track_id}/refine",
    response_model=JobAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def refine_track(
    track_id: UUID,
    body: RefineRequest,
    user_id: UUID = Depends(require_user),
) -> JobAccepted:
    """
    Regenerate a track with a natural-language adjustment applied (PE-03, fresh).

    The prompt is composed deterministically here rather than through an LLM —
    see compose_refined_prompt for why there is no Bedrock call on this path.
    """
    if body.refinement_mode is RefinementMode.AUDIO_REFERENCE:
        raise UnsupportedRefinementException()

    parent = await _parent_or_404(track_id, user_id)
    params = GenerationParams.model_validate(
        {
            **parent["params"],
            "prompt": compose_refined_prompt(parent["prompt"], body.delta_command),
            "delta_command": body.delta_command,
            "seed": new_seed(),
        }
    )
    return await _submit(
        user_id=user_id,
        kind="refine_fresh",
        params=params,
        parent_track_id=track_id,
    )


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
                event = await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_SECONDS)
            except TimeoutError:
                # A NAMED event, not the conventional `: keepalive` comment.
                # Comments are invisible to the browser's EventSource — no
                # handler fires for them — so a client cannot tell "the server
                # is still talking to me, the job just hasn't moved" from "this
                # stream is open but dead because the completion landed on
                # another API task". The client's staleness watchdog needs that
                # distinction, and this is the only way it can observe one.
                # Clients that do not listen for it simply drop it.
                yield _frame("keepalive", {})
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


@router.get("/jobs/{job_id}", response_model=JobStatusResponse)
async def job_status(
    job_id: UUID,
    user_id: UUID = Depends(require_user),
) -> JobStatusResponse:
    """
    Current status of one job.

    This is what makes the client's polling fallback possible. Without it, a
    client whose SSE stream dies — a deploy briefly running two API tasks, or a
    stream token that outlived a cold start — has literally no way to learn that
    its job finished, and the only honest UI left is a spinner that never
    resolves.

    Polled at 5s intervals by any stranded client, so it stays one statement.
    """
    row = await generation_service.load_job_status(job_id=job_id, user_id=user_id)
    if row is None:
        # Unknown and foreign are the same answer, on purpose.
        raise ResourceNotFoundException("Job", str(job_id))

    completed = row.status == "COMPLETED"
    return JobStatusResponse(
        job_id=row.id,
        status=row.status,  # type: ignore[arg-type]  # CHECK-constrained in DDL
        kind=row.kind,
        created_at=row.created_at,
        started_at=row.started_at,
        completed_at=row.completed_at,
        error=row.error,
        track_id=row.track_id,
        mp3_url=(presign_get(row.s3_mp3_key) if completed and row.s3_mp3_key else None),
    )


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
        payload = verify(token, _settings.sse_token_secret.get_secret_value())
    except SSETokenExpired as exc:
        # Distinct from every other 401 so the client can tell "poll instead"
        # from "log out" — see SSETokenExpiredException.
        raise SSETokenExpiredException() from exc
    except SSETokenError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid or expired token"
        ) from exc

    if payload.get("jid") != job_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token/job mismatch")

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


@dev_router.post("/internal/dev/enqueue-test-job", response_model=DevEnqueueResponse)
async def enqueue_test_job(body: DevEnqueueRequest) -> DevEnqueueResponse:
    """
    Drive the full write path without an auth flow. Gate C leans on this.

    Mounted only when settings.rithm_dev_endpoints is true — guarded at
    include_router() time, so in prod the route simply does not exist.
    """
    params = body.params or GenerationParams(prompt="stub test tone", length_seconds=30)
    # No rate_limit: dev-enqueue must be able to drive a gate repeatedly
    # without burning a real user's daily budget.
    job_id, _ = await generation_service.submit(
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
