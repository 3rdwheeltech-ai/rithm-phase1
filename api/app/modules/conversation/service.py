"""
Conversation persistence — one live session per user, its transcript, and the
draft it is building.

Like generation and catalog, and unlike identity, this service opens its OWN
sessions rather than taking one from a FastAPI dependency. A chat turn makes
two Bedrock calls between its first write and its last, and a request-scoped
session would hold a pooled connection open across both of them
(pool_size=5 + max_overflow=5 → ten concurrent chat turns, then everything
blocks — including generation).

Raw `text()` SQL with schema-qualified names, matching the rest of the tree.
This module imports nothing from any other module (import-linter's independence
contract lists `app.modules.conversation`).
"""

import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import structlog
import tiktoken
from sqlalchemy import text
from uuid_utils import uuid7

from app.config import get_settings
from app.modules.conversation.models import (
    MESSAGE_COLUMNS,
    MESSAGES_TABLE,
    SESSION_COLUMNS,
    SESSIONS_TABLE,
    Message,
    MessageRole,
    Session,
    SessionState,
)
from app.shared.db import get_session

logger = structlog.get_logger()

# A floor under the token budget, not a second budget. The session cap is 60
# messages, so this can never bite in practice — it exists so that a mis-set
# `chat_history_token_budget` cannot turn into an unbounded SELECT.
_HISTORY_MAX_ROWS = 200

# What GPT-family tokenisers call the modern encoding. It is NOT Nova's or
# Claude's tokeniser and does not pretend to be: `token_count` is documented on
# the column as an *estimate used for history truncation*, and every model in
# the chain is within ~15% of this one on English prose. Being roughly right
# about a 3000-token budget is the entire requirement.
_ENCODING_NAME = "cl100k_base"

_encoder: Any = None


def count_tokens(content: str) -> int:
    """
    Roughly how much context a message will cost.

    tiktoken's first call loads (and on a cold cache downloads) a BPE table,
    which takes seconds — so the encoder is built once and kept. A build
    failure, which is what an air-gapped container looks like, falls back to
    the four-characters-per-token rule of thumb rather than taking the chat
    down: this number decides how much history to send, and being approximately
    right is the whole job.
    """
    global _encoder
    if _encoder is None:
        try:
            _encoder = tiktoken.get_encoding(_ENCODING_NAME)
        except Exception as exc:  # deliberately blind — see the docstring
            logger.warning("tiktoken_unavailable", error=type(exc).__name__)
            _encoder = False
    if _encoder is False:
        return max(1, len(content) // 4)
    return len(_encoder.encode(content))


def is_idle(session: Session, *, max_idle_seconds: int) -> bool:
    """
    Has this conversation sat untouched long enough to be over?

    ONE DEFINITION, TWO CALLERS, and they must behave differently — which is
    why this is a free function rather than a branch inside `load`.

    `service.start` (the write path) soft-deletes a stale session and opens a
    fresh one. `GET /chat/session` (the read path) reports a stale session as
    NO session, and writes nothing: "a bare GET creates nothing" is that
    route's documented invariant and it holds in both directions.

    Both are needed. Expiring only on write means the user reads a transcript
    that vanishes the instant they reply to it, which is worse than either
    keeping it or dropping it consistently.

    `updated_at` rather than the last message's timestamp: the
    touch_updated_at trigger bumps it on every save_draft, so it already tracks
    real activity, and reading it costs no second query. A session row with no
    `updated_at` at all is treated as live — a missing timestamp is not
    evidence of staleness, and deleting somebody's conversation is not the
    thing to do on a guess.
    """
    if max_idle_seconds <= 0 or session.updated_at is None:
        return False
    age = datetime.now(UTC) - session.updated_at
    return age > timedelta(seconds=max_idle_seconds)


class ConversationService:
    # ── Sessions ───────────────────────────────────────────────────────────

    async def load(self, *, user_id: UUID) -> Session | None:
        """
        The user's live session, or None.

        There is at most one: `sessions_one_active_per_user` is a UNIQUE
        partial index on (user_id) WHERE deleted_at IS NULL. No ORDER BY and no
        LIMIT, deliberately — if a second row ever appears, this query is where
        it should be noticed rather than quietly picking a winner.
        """
        async with get_session("conversation") as session:
            row = (
                (
                    await session.execute(
                        text(
                            f"SELECT {SESSION_COLUMNS} "  # noqa: S608 — constants
                            f"FROM {SESSIONS_TABLE} "
                            "WHERE user_id = CAST(:user_id AS uuid) "
                            "  AND deleted_at IS NULL"
                        ),
                        {"user_id": str(user_id)},
                    )
                )
                .mappings()
                .first()
            )
        return Session.from_row(row) if row is not None else None

    async def start(self, *, user_id: UUID) -> Session:
        """
        The user's live session, creating one if there isn't one.

        `INSERT … ON CONFLICT DO NOTHING` then re-select, rather than
        "SELECT, and INSERT if empty". Two tabs, a double-click and
        StrictMode's double effect all race here, and with the unique index in
        place the race resolves in the database instead of forking the
        transcript. No conflict TARGET is named on purpose: the index is
        partial, so naming one would mean restating its predicate here for a
        statement that has nothing else to do on conflict anyway.

        Called on the first user MESSAGE, never on a bare GET — an abandoned
        chat panel must not litter the table.

        A conversation that has sat untouched past `chat_session_idle_seconds`
        is retired here before the insert, so the next message starts clean
        rather than resuming something the user has long since walked away
        from. The soft delete releases the unique partial index, which is what
        lets the INSERT below actually take.
        """
        stale = await self.load(user_id=user_id)
        if stale is not None and is_idle(
            stale, max_idle_seconds=get_settings().chat_session_idle_seconds
        ):
            logger.info(
                "chat_session_expired",
                idle_seconds=get_settings().chat_session_idle_seconds,
            )
            await self.soft_delete(session_id=stale.id)

        async with get_session("conversation") as session:
            await session.execute(
                text(
                    f"INSERT INTO {SESSIONS_TABLE} (id, user_id, current_state) "  # noqa: S608
                    "VALUES (CAST(:id AS uuid), CAST(:user_id AS uuid), :state) "
                    "ON CONFLICT DO NOTHING"
                ),
                {
                    "id": str(uuid7()),
                    "user_id": str(user_id),
                    "state": SessionState.DESCRIBING.value,
                },
            )

        existing = await self.load(user_id=user_id)
        if existing is None:
            # Unreachable short of the row being deleted between the two
            # statements above. Loud rather than a None the caller has to
            # re-handle three frames up.
            raise RuntimeError("conversation session vanished immediately after insert")
        return existing

    async def save_draft(
        self,
        *,
        session_id: UUID,
        draft: dict[str, Any],
        ready: bool,
        voice: bool = False,
    ) -> None:
        """
        Persist the merged draft and drive `current_state` with it.

        READY_TO_EXPORT gates the DraftCard, so the column is real state rather
        than decoration — and it can go back to DESCRIBING, because a user who
        says "actually make it instrumental, no — sung" can un-complete a draft.

        `voice` finally gives `sessions.voice_enabled` a writer. That column has
        existed since 0001_conversation_baseline and — confirmed by grep — has
        never been written by anything, so no DDL is needed here. It rides on
        the UPDATE that was already happening rather than costing a second
        round trip, and it is STICKY: `OR :voice` rather than `= :voice`,
        because a conversation held half by voice and half by typing was still
        a voice conversation, and the Chat door writing the flag back to false
        would erase that.
        """
        state = (
            SessionState.READY_TO_EXPORT.value
            if ready
            else SessionState.DESCRIBING.value
        )
        async with get_session("conversation") as session:
            await session.execute(
                text(
                    f"UPDATE {SESSIONS_TABLE} "  # noqa: S608 — constants
                    "SET draft = CAST(:draft AS JSONB), current_state = :state, "
                    "    voice_enabled = voice_enabled OR :voice "
                    "WHERE id = CAST(:id AS uuid)"
                ),
                {
                    "id": str(session_id),
                    "draft": json.dumps(draft),
                    "state": state,
                    "voice": voice,
                },
            )

    async def soft_delete(self, *, session_id: UUID) -> None:
        """
        "Start over". The row stays; `deleted_at` releases the unique index so
        the next message can open a fresh session.

        The messages are NOT deleted — the FK cascades only on a hard delete
        and `conversation.messages` has no `deleted_at`. That is a known,
        named gap: the rows accumulate and this schema needs a retention job
        before the scale makes it matter.
        """
        async with get_session("conversation") as session:
            await session.execute(
                text(
                    f"UPDATE {SESSIONS_TABLE} SET deleted_at = now() "  # noqa: S608
                    "WHERE id = CAST(:id AS uuid) AND deleted_at IS NULL"
                ),
                {"id": str(session_id)},
            )

    # ── Messages ───────────────────────────────────────────────────────────

    async def append(
        self,
        *,
        session_id: UUID,
        role: MessageRole,
        content: str,
        tool_calls: dict[str, Any] | None = None,
        token_count: int | None = None,
    ) -> Message:
        """
        One turn, committed.

        `tool_calls` carries the parsed draft delta — which is what that column
        was named for, back when the plan was Bedrock tool-use. Storing it is
        what makes "why did the draft end up like this?" answerable from a
        SELECT rather than from a log search.
        """
        async with get_session("conversation") as session:
            row = (
                (
                    await session.execute(
                        text(
                            f"INSERT INTO {MESSAGES_TABLE} "  # noqa: S608 — constants
                            "(id, session_id, role, content, tool_calls, token_count) "
                            "VALUES (CAST(:id AS uuid), CAST(:session_id AS uuid), "
                            ":role, :content, CAST(:tool_calls AS JSONB), "
                            ":token_count) "
                            f"RETURNING {MESSAGE_COLUMNS}"
                        ),
                        {
                            "id": str(uuid7()),
                            "session_id": str(session_id),
                            "role": role.value,
                            "content": content,
                            "tool_calls": (
                                json.dumps(tool_calls)
                                if tool_calls is not None
                                else None
                            ),
                            "token_count": (
                                token_count
                                if token_count is not None
                                else count_tokens(content)
                            ),
                        },
                    )
                )
                .mappings()
                .first()
            )
        if row is None:
            raise RuntimeError("message insert returned no row")
        return Message.from_row(row)

    async def transcript(self, *, session_id: UUID) -> list[Message]:
        """The whole conversation, oldest first — what the SPA renders."""
        async with get_session("conversation") as session:
            rows = (
                (
                    await session.execute(
                        text(
                            f"SELECT {MESSAGE_COLUMNS} "  # noqa: S608 — constants
                            f"FROM {MESSAGES_TABLE} "
                            "WHERE session_id = CAST(:session_id AS uuid) "
                            "ORDER BY created_at ASC, id ASC "
                            "LIMIT :limit"
                        ),
                        {"session_id": str(session_id), "limit": _HISTORY_MAX_ROWS},
                    )
                )
                .mappings()
                .all()
            )
        return [Message.from_row(row) for row in rows]

    async def history(self, *, session_id: UUID, token_budget: int) -> list[Message]:
        """
        As much recent history as fits the budget, oldest first.

        A TOKEN budget, not a message count. `messages.token_count` is
        documented on the column as "estimate, used for history truncation" and
        `tiktoken` has been in pyproject.toml for exactly this since the schema
        was written — because a fixed "last 24 messages" blows the context
        window the first time someone pastes a verse into the box.

        Walks newest-first so the turns nearest the question always survive,
        then reverses: the model needs them in the order they were said.
        """
        async with get_session("conversation") as session:
            rows = (
                (
                    await session.execute(
                        text(
                            f"SELECT {MESSAGE_COLUMNS} "  # noqa: S608 — constants
                            f"FROM {MESSAGES_TABLE} "
                            "WHERE session_id = CAST(:session_id AS uuid) "
                            "ORDER BY created_at DESC, id DESC "
                            "LIMIT :limit"
                        ),
                        {"session_id": str(session_id), "limit": _HISTORY_MAX_ROWS},
                    )
                )
                .mappings()
                .all()
            )

        kept: list[Message] = []
        spent = 0
        for row in rows:
            message = Message.from_row(row)
            cost = message.token_count or count_tokens(message.content)
            # The newest message is kept unconditionally: dropping the turn the
            # model is meant to answer would be worse than overrunning by one.
            if kept and spent + cost > token_budget:
                break
            kept.append(message)
            spent += cost
        kept.reverse()
        return kept

    # ── Caps ───────────────────────────────────────────────────────────────

    async def count(self, *, session_id: UUID) -> int:
        """Messages the USER has sent in this session — i.e. turns taken."""
        async with get_session("conversation") as session:
            result = await session.execute(
                text(
                    f"SELECT count(*) FROM {MESSAGES_TABLE} "  # noqa: S608 — constants
                    "WHERE session_id = CAST(:session_id AS uuid) AND role = :role"
                ),
                {"session_id": str(session_id), "role": MessageRole.USER.value},
            )
        return int(result.scalar_one())

    async def count_today(self, *, user_id: UUID) -> int:
        """
        Turns this user has taken across all their sessions in 24 hours.

        The spend cap, and it counts USER messages for the same reason
        `count` does: one user message is one turn is two Bedrock calls, and
        counting the replies too would make the number mean half of what it
        says. Rolling window rather than calendar day — matching
        generation's rate limiter, so the two read the same way.
        """
        async with get_session("conversation") as session:
            result = await session.execute(
                text(
                    "SELECT count(*) "
                    f"FROM {MESSAGES_TABLE} m "  # noqa: S608 — constants
                    f"JOIN {SESSIONS_TABLE} s ON s.id = m.session_id "
                    "WHERE s.user_id = CAST(:user_id AS uuid) "
                    "  AND m.role = :role "
                    "  AND m.created_at > now() - interval '24 hours'"
                ),
                {"user_id": str(user_id), "role": MessageRole.USER.value},
            )
        return int(result.scalar_one())


# The module singleton, matching generation_service and catalog_service:
# patching it in a test patches one thing rather than two that behave alike.
conversation_service = ConversationService()
