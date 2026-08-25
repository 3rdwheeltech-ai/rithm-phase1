"""
Schema contract for `conversation.sessions` and `conversation.messages`.

Deliberately NOT SQLAlchemy ORM models, for the reasons recorded in
generation/models.py: this codebase has no declarative Base, persistence is raw
`text()` SQL with schema-qualified names, and migrations/conversation/env.py
sets `target_metadata = None` because migrations are hand-written DDL.

The tables already exist (0001_conversation_baseline); `sessions.draft` and the
one-live-session index arrive in 0002_conversation_session_draft. Nothing here
migrates them.
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, cast
from uuid import UUID

from sqlalchemy import RowMapping

SESSIONS_TABLE = "conversation.sessions"
MESSAGES_TABLE = "conversation.messages"


class SessionState(StrEnum):
    """
    Mirrors the sessions_state_vals CHECK constraint.

    The chat flow uses two of the four: DESCRIBING while it is still
    collecting, READY_TO_EXPORT once the draft has everything the Create form
    needs. AWAITING_GEN and REFINING belong to the cut generate-from-chat and
    refine-by-chat features and are never written here.
    """

    DESCRIBING = "DESCRIBING"
    AWAITING_GEN = "AWAITING_GEN"
    REFINING = "REFINING"
    READY_TO_EXPORT = "READY_TO_EXPORT"


class MessageRole(StrEnum):
    """
    The two roles this module writes.

    messages_role_vals also allows 'system'; nothing here writes one. The
    system prompt is rebuilt from the draft on every turn, so persisting a copy
    would only give the two something to disagree about.
    """

    USER = "user"
    ASSISTANT = "assistant"


def decode_json_column(value: object) -> dict[str, Any]:
    """
    A JSONB column as a dict, whichever way the driver hands it over.

    Mirrors catalog/service.py's `_decode_params`: asyncpg's JSONB codec
    normally decodes this already, but accepting a str keeps the function
    honest against a codec change and against test doubles.
    """
    if isinstance(value, str | bytes):
        try:
            # Annotated `object`, not left as json.loads's `Any`: under pyright
            # strict every downstream touch of an Any is a fresh error, and the
            # baseline fails at one more than it has.
            decoded: object = json.loads(value)
        except ValueError:
            return {}
        value = decoded
    if isinstance(value, dict):
        return cast(dict[str, Any], value)
    return {}


@dataclass(frozen=True, slots=True)
class Session:
    """One row of conversation.sessions, typed."""

    id: UUID
    user_id: UUID
    current_state: str
    active_track_id: UUID | None
    voice_enabled: bool
    draft: dict[str, Any] = field(default_factory=dict[str, Any])
    created_at: datetime | None = None
    updated_at: datetime | None = None
    deleted_at: datetime | None = None

    @classmethod
    def from_row(cls, row: RowMapping) -> "Session":
        return cls(
            id=row["id"],
            user_id=row["user_id"],
            current_state=row["current_state"],
            active_track_id=row["active_track_id"],
            voice_enabled=row["voice_enabled"],
            draft=decode_json_column(row["draft"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            deleted_at=row["deleted_at"],
        )


@dataclass(frozen=True, slots=True)
class Message:
    """One row of conversation.messages, typed."""

    id: UUID
    session_id: UUID
    role: str
    content: str
    tool_calls: dict[str, Any]
    audio_s3_key: str | None
    token_count: int | None
    created_at: datetime

    @classmethod
    def from_row(cls, row: RowMapping) -> "Message":
        return cls(
            id=row["id"],
            session_id=row["session_id"],
            role=row["role"],
            content=row["content"],
            tool_calls=decode_json_column(row["tool_calls"]),
            audio_s3_key=row["audio_s3_key"],
            token_count=row["token_count"],
            created_at=row["created_at"],
        )


# Column lists shared by the SELECTs in service.py — these keep the queries in
# sync with the two from_row methods above.
SESSION_COLUMNS = (
    "id, user_id, current_state, active_track_id, voice_enabled, draft, "
    "created_at, updated_at, deleted_at"
)
MESSAGE_COLUMNS = (
    "id, session_id, role, content, tool_calls, audio_s3_key, token_count, created_at"
)
