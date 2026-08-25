"""
The chat assistant's HTTP surface.

Three routes, all scoped to the caller. There is no session id in any path —
every route resolves the user's ONE live session from `require_user`, which is
what makes another user's conversation invisible by construction rather than by
an ownership check somebody has to remember to write.

Mounted under /api/v1 in main.py. No ops change is needed for routing:
CloudFront's `/api/*` behaviour forwards wholesale to the ALB, whose listener
has a single default forward rule.
"""

from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Response, status

from app.config import get_settings
from app.modules.conversation import agent
from app.modules.conversation.models import Message, MessageRole, SessionState
from app.modules.conversation.schemas import (
    ChatMessageOut,
    ChatSessionResponse,
    ChatTurnRequest,
    ChatTurnResponse,
    SongDraft,
)
from app.modules.conversation.service import conversation_service, count_tokens
from app.shared.auth import require_user
from app.shared.aws import ConverseMessage
from app.shared.exceptions import (
    ChatSessionFullException,
    RateLimitExceededException,
)

logger = structlog.get_logger()

router = APIRouter(tags=["conversation"])

# A rolling 24h window has no single moment it frees up — the answer depends on
# which message ages out first, and the honest one costs a second query on a
# path nobody should ever reach. An hour is a "check back later" hint, and its
# job is to stop a client retrying in a loop rather than to name a deadline.
_DAILY_RETRY_AFTER_SECONDS = 3600


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
    """
    session = await conversation_service.load(user_id=user_id)
    if session is None:
        return ChatSessionResponse(
            session_id=None, messages=[], draft=SongDraft(), ready=False
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
