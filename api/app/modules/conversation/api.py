"""
The chat assistant's HTTP surface.

Five routes, all scoped to the caller. There is no session id in any path —
every route resolves the user's ONE live session from `require_user`, which is
what makes another user's conversation invisible by construction rather than by
an ownership check somebody has to remember to write.

The two voice routes sit under /chat rather than under a new top-level
/voice: this module's paths are all under /chat and collide with nothing above
it in main.py, and a new prefix quietly voids that. /session rather than
/session-token, because the response carries a lease and the DELETE is
genuinely about a session.

Mounted under /api/v1 in main.py. No ops change is needed for routing:
CloudFront's `/api/*` behaviour forwards wholesale to the ALB, whose listener
has a single default forward rule.
"""

from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Response, status
from uuid_utils import uuid7

from app.config import get_settings
from app.modules.conversation import agent, anam
from app.modules.conversation.lease import voice_lease, voice_starts
from app.modules.conversation.models import Message, MessageRole, SessionState
from app.modules.conversation.schemas import (
    ChatMessageOut,
    ChatSessionResponse,
    ChatTurnRequest,
    ChatTurnResponse,
    SongDraft,
    VoiceSessionResponse,
)
from app.modules.conversation.service import conversation_service, count_tokens
from app.shared.auth import require_user
from app.shared.aws import ConverseMessage
from app.shared.exceptions import (
    ChatSessionFullException,
    RateLimitExceededException,
    VoiceNotConfiguredException,
    VoiceQuotaExceededException,
)

logger = structlog.get_logger()

router = APIRouter(tags=["conversation"])

# A rolling 24h window has no single moment it frees up — the answer depends on
# which message ages out first, and the honest one costs a second query on a
# path nobody should ever reach. An hour is a "check back later" hint, and its
# job is to stop a client retrying in a loop rather than to name a deadline.
_DAILY_RETRY_AFTER_SECONDS = 3600

# What a user over their daily VOICE cap is told to wait. An hour, for the same
# reason and with the same honesty as the constant above: the window is rolling,
# so no single moment frees it up, and the number's job is to stop a client
# retrying in a loop rather than to name a deadline.
_VOICE_QUOTA_RETRY_AFTER_SECONDS = 3600


def _out(message: Message) -> ChatMessageOut:
    return ChatMessageOut(
        id=message.id,
        role=message.role,
        content=message.content,
        created_at=message.created_at,
    )


def _to_converse(messages: list[Message]) -> list[ConverseMessage]:
    """
    The transcript in Bedrock's shape.

    Roles are narrowed to user/assistant because Converse accepts nothing else;
    this module never writes a 'system' row, so the filter is belt and braces
    against a row somebody adds by hand.
    """
    turns: list[ConverseMessage] = []
    for message in messages:
        if message.role == MessageRole.USER.value:
            turns.append({"role": "user", "content": [{"text": message.content}]})
        elif message.role == MessageRole.ASSISTANT.value:
            turns.append({"role": "assistant", "content": [{"text": message.content}]})
    return turns


@router.get("/chat/session", response_model=ChatSessionResponse)
async def get_chat_session(
    user_id: UUID = Depends(require_user),
) -> ChatSessionResponse:
    """
    Resume the conversation, or report that there isn't one.

    Creates NOTHING. A user who opens the panel and closes it again must not
    leave a row behind, so the session is created lazily on their first
    message instead (see service.start).

    It also carries `voice_available`, which is how the SPA learns whether to
    offer Talk WITHOUT spending the one global Anam slot to find out.
    """
    settings = get_settings()
    session = await conversation_service.load(user_id=user_id)
    if session is None:
        return ChatSessionResponse(
            session_id=None,
            messages=[],
            draft=SongDraft(),
            ready=False,
            voice_available=settings.anam_enabled,
        )

    messages = await conversation_service.transcript(session_id=session.id)
    return ChatSessionResponse(
        session_id=session.id,
        messages=[_out(m) for m in messages],
        draft=SongDraft.model_validate(session.draft),
        # Read off the COLUMN, not re-derived from the draft. save_draft writes
        # it from draft_is_ready on every turn, so the column is the state
        # rather than a decoration — and one reader means the two can never
        # disagree about what the SPA should show.
        ready=session.current_state == SessionState.READY_TO_EXPORT.value,
        voice_available=settings.anam_enabled,
    )


@router.post("/chat/messages", response_model=ChatTurnResponse)
async def post_chat_message(
    body: ChatTurnRequest,
    user_id: UUID = Depends(require_user),
) -> ChatTurnResponse:
    """
    One turn: their message in, the assistant's reply out, the draft moved.

    THE USER'S MESSAGE IS COMMITTED BEFORE THE MODEL IS CALLED, and stays
    committed if the model fails. A transcript that ends on an unanswered user
    turn is the honest record and the SPA offers a retry; wrapping the turn in
    a rollback would silently eat what they typed.
    """
    settings = get_settings()
    # Which door this came through. The transport is the ONLY thing that
    # differs: the same agent, the same draft, the same caps, the same
    # transcript. Talk and Chat are two doors on one conversation.
    voice = body.source == "voice"

    # The DAILY cap first, because it is the only check that needs no session —
    # and a user who is over it must not have an empty session row created for
    # them as a side effect of being refused.
    today = await conversation_service.count_today(user_id=user_id)
    if today >= settings.chat_max_messages_per_day:
        raise RateLimitExceededException(
            retry_after_seconds=_DAILY_RETRY_AFTER_SECONDS,
            used=today,
            limit=settings.chat_max_messages_per_day,
        )

    session = await conversation_service.start(user_id=user_id)

    # 409, not 429: nothing is rate-limited here and waiting will not help. The
    # fix is "Start over", which is a different control from a Retry-After.
    turns = await conversation_service.count(session_id=session.id)
    if turns >= settings.chat_max_messages_per_session:
        raise ChatSessionFullException(settings.chat_max_messages_per_session)

    text = body.message.strip()
    await conversation_service.append(
        session_id=session.id,
        role=MessageRole.USER,
        content=text,
        token_count=count_tokens(text),
    )

    draft = SongDraft.model_validate(session.draft)
    history = _to_converse(
        await conversation_service.history(
            session_id=session.id,
            token_budget=settings.chat_history_token_budget,
        )
    )

    # Raises AssistantUnavailableException when every model refused or the turn
    # ran out of budget. Deliberately NOT caught: the user's message is already
    # committed, so a 503 here loses nothing.
    result = await agent.run_turn(history=history, draft=draft)

    await conversation_service.save_draft(
        session_id=session.id,
        draft=result.draft.model_dump(mode="json"),
        ready=result.ready,
        # Rides the write that was already happening — no extra round trip and
        # no new service method. This is what finally gives
        # `sessions.voice_enabled` a writer.
        voice=voice,
    )
    assistant_message = await conversation_service.append(
        session_id=session.id,
        role=MessageRole.ASSISTANT,
        content=result.reply,
        # The parsed delta, which is what this column was named for.
        tool_calls={"draft_delta": result.delta.model_dump(mode="json")},
        token_count=count_tokens(result.reply),
    )

    # Lengths, counts and flags only — never the words (agent.py rule 3).
    logger.info(
        "chat_turn",
        offline=result.offline,
        ready=result.ready,
        turns=turns + 1,
        history_messages=len(history),
        # Makes "how much of our traffic is voice, and is it slower?"
        # answerable from CloudWatch rather than from a guess.
        voice=voice,
    )
    return ChatTurnResponse(
        message=_out(assistant_message),
        draft=result.draft,
        ready=result.ready,
        suggestions=result.suggestions,
    )


@router.delete("/chat/session", status_code=status.HTTP_204_NO_CONTENT)
async def delete_chat_session(user_id: UUID = Depends(require_user)) -> Response:
    """
    Start over. Idempotent: no session is already the desired end state.

    A soft delete. The transcript stays in `conversation.messages` — the FK
    cascades only on a hard delete and that table has no `deleted_at` — which
    is a named gap rather than a solved one: those rows accumulate and want a
    retention job before the scale makes it matter.
    """
    session = await conversation_service.load(user_id=user_id)
    if session is not None:
        await conversation_service.soft_delete(session_id=session.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Voice ──────────────────────────────────────────────────────────────────


@router.post(
    "/chat/voice/session",
    response_model=VoiceSessionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def start_voice_session(
    response: Response,
    user_id: UUID = Depends(require_user),
) -> VoiceSessionResponse:
    """
    Mint one Anam session token, and take the one global slot while it lasts.

    POST, NOT GET, even though it reads nothing: it mints a credential, spends
    metered minutes and claims a slot that is global to the whole product. GET
    is the verb browsers prefetch, link-checkers follow and caches are tempted
    to keep.

    THE ORDER OF OPERATIONS IS THE DESIGN:

    1. Not configured → 501 BEFORE anything else, so a deployment with no key
       costs zero outbound requests.
    2. This user's daily cap on session starts → 429.
    3. Claim the lease → 429 with a real Retry-After if someone else holds it.
    4. Mint. On ANY failure, release the lease and re-raise — otherwise a vendor
       outage parks the one slot for three minutes.
    5. Count the start, and answer with `Cache-Control: no-store`.
    """
    settings = get_settings()

    if not settings.anam_enabled:
        raise VoiceNotConfiguredException()

    started_today = await voice_starts.count(user_id=user_id)
    if started_today >= settings.anam_max_sessions_per_user_per_day:
        raise VoiceQuotaExceededException(
            limit=settings.anam_max_sessions_per_user_per_day,
            retry_after_seconds=_VOICE_QUOTA_RETRY_AFTER_SECONDS,
        )

    # ADVISORY toward Anam, so the TTL must exceed the session cap: a client
    # that overruns must still be holding a lease when it does, or the lease
    # has lied to the next caller.
    ttl = settings.anam_session_seconds + settings.anam_lease_slack_seconds
    lease_id = UUID(str(uuid7()))
    lease = await voice_lease.claim(user_id=user_id, lease_id=lease_id, ttl_seconds=ttl)

    try:
        session_token = await anam.mint_session_token()
    except Exception:
        # Claim before minting, release on the failure path. Without this a
        # vendor outage holds the product's only slot for the full TTL.
        await voice_lease.release(lease_id=lease.lease_id, user_id=user_id)
        raise

    await voice_starts.record(user_id=user_id)

    # The token outlives its usefulness by twenty times. Nothing may keep it.
    response.headers["Cache-Control"] = "no-store"
    logger.info("voice_session_started", ttl_seconds=ttl)
    return VoiceSessionResponse(
        session_token=session_token,
        expires_in_seconds=settings.anam_session_seconds,
        lease_id=lease.lease_id,
    )


@router.delete("/chat/voice/session", status_code=status.HTTP_204_NO_CONTENT)
async def end_voice_session(
    lease_id: UUID,
    user_id: UUID = Depends(require_user),
) -> Response:
    """
    Hand the slot back. Idempotent — releasing a lease you do not hold is
    already the desired end state, so this is 204 either way.

    It takes the lease id because a STALE tab's unload must not free the slot
    the user's current tab is holding. The lease's TTL is the real guarantee
    behind this call: `navigator.sendBeacon` cannot set an Authorization
    header, so the unload path is `fetch(..., {keepalive: true})`, which
    Firefox before 133 does not implement. This is an optimisation on top of
    the TTL, never the recovery story.
    """
    await voice_lease.release(lease_id=lease_id, user_id=user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
