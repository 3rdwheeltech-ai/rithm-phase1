"""
The chat routes, end to end against an in-memory conversation database.

WITH BEDROCK DISABLED — which is the default, and what CI runs — the offline
interviewer answers, so these are real end-to-end route tests rather than tests
of a mock: the request goes through require_user, the caps, the service's real
SQL, the real agent and back out as a real response body.

The fake database interprets the statements rather than replaying a positional
script, for one specific reason: the most important thing to assert here is
that a SECOND concurrent POST does not fork the transcript, and that behaviour
lives in `INSERT … ON CONFLICT DO NOTHING` against the unique partial index.
A script cannot be wrong about that; a store that enforces the index can.
"""

import json
from collections.abc import AsyncGenerator, AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.modules.conversation import agent
from app.modules.conversation import service as conversation_service_module
from app.shared.auth import require_user
from app.shared.exceptions import AssistantUnavailableException
from tests.conftest import FakeResult

USER_ID = UUID("00000000-0000-7000-8000-0000000000c1")
OTHER_USER_ID = UUID("00000000-0000-7000-8000-0000000000c2")


class FakeConversationDb:
    """
    conversation.sessions and conversation.messages, in two lists.

    Enough of AsyncSession's surface for the raw-SQL service, and enough of
    Postgres's to enforce the one constraint the design leans on:
    `sessions_one_active_per_user`.
    """

    def __init__(self) -> None:
        self.sessions: list[dict[str, Any]] = []
        self.messages: list[dict[str, Any]] = []
        self.statements: list[str] = []
        self._clock = datetime.now(UTC)

    def _tick(self) -> datetime:
        """Distinct, ordered timestamps — the ORDER BYs are what's under test."""
        self._clock += timedelta(milliseconds=1)
        return self._clock

    def _live_session(self, user_id: str) -> dict[str, Any] | None:
        return next(
            (
                row
                for row in self.sessions
                if str(row["user_id"]) == user_id and row["deleted_at"] is None
            ),
            None,
        )

    async def execute(self, statement: Any, params: Any = None) -> FakeResult:
        sql = " ".join(str(statement).split())
        args: dict[str, Any] = params or {}
        self.statements.append(sql)

        if sql.startswith("INSERT INTO conversation.sessions"):
            # ON CONFLICT DO NOTHING against the unique partial index.
            if self._live_session(args["user_id"]) is None:
                self.sessions.append(
                    {
                        "id": UUID(args["id"]),
                        "user_id": UUID(args["user_id"]),
                        "current_state": args["state"],
                        "active_track_id": None,
                        "voice_enabled": False,
                        "draft": None,
                        "created_at": self._tick(),
                        "updated_at": self._tick(),
                        "deleted_at": None,
                    }
                )
            return FakeResult([])

        if sql.startswith("SELECT id, user_id, current_state"):
            row = self._live_session(args["user_id"])
            return FakeResult([row] if row is not None else [])

        if sql.startswith("UPDATE conversation.sessions SET draft"):
            for row in self.sessions:
                if str(row["id"]) == args["id"]:
                    row["draft"] = args["draft"]
                    row["current_state"] = args["state"]
                    # `voice_enabled = voice_enabled OR :voice` — sticky, so a
                    # conversation continued by typing does not un-mark itself.
                    row["voice_enabled"] = row["voice_enabled"] or args["voice"]
            return FakeResult([])

        if sql.startswith("UPDATE conversation.sessions SET deleted_at"):
            for row in self.sessions:
                if str(row["id"]) == args["id"] and row["deleted_at"] is None:
                    row["deleted_at"] = self._tick()
            return FakeResult([])

        if sql.startswith("INSERT INTO conversation.messages"):
            row = {
                "id": UUID(args["id"]),
                "session_id": UUID(args["session_id"]),
                "role": args["role"],
                "content": args["content"],
                "tool_calls": args["tool_calls"],
                "audio_s3_key": None,
                "token_count": args["token_count"],
                "created_at": self._tick(),
            }
            self.messages.append(row)
            return FakeResult([row])

        if sql.startswith("SELECT count(*) FROM conversation.messages m JOIN"):
            return FakeResult(
                [
                    (
                        sum(
                            1
                            for m in self.messages
                            if m["role"] == args["role"]
                            and str(self._session_of(m)["user_id"]) == args["user_id"]
                        ),
                    )
                ]
            )

        if sql.startswith("SELECT count(*) FROM conversation.messages"):
            return FakeResult(
                [
                    (
                        sum(
                            1
                            for m in self.messages
                            if str(m["session_id"]) == args["session_id"]
                            and m["role"] == args["role"]
                        ),
                    )
                ]
            )

        if sql.startswith("SELECT content FROM conversation.messages"):
            # service.last_assistant_text — newest row of one role, or nothing.
            rows = [
                m
                for m in self.messages
                if str(m["session_id"]) == args["session_id"]
                and m["role"] == args["role"]
            ]
            rows.sort(key=lambda m: m["created_at"], reverse=True)
            return FakeResult([(rows[0]["content"],)] if rows else [])

        if sql.startswith("SELECT id, session_id, role"):
            rows = [
                m for m in self.messages if str(m["session_id"]) == args["session_id"]
            ]
            rows.sort(key=lambda m: m["created_at"], reverse="DESC" in sql)
            return FakeResult(rows[: args["limit"]])

        raise AssertionError(f"unhandled statement: {sql}")

    def _session_of(self, message: dict[str, Any]) -> dict[str, Any]:
        return next(s for s in self.sessions if s["id"] == message["session_id"])


@pytest.fixture(autouse=True)
def db(monkeypatch: pytest.MonkeyPatch) -> FakeConversationDb:
    store = FakeConversationDb()

    @asynccontextmanager
    async def _session(_module: str) -> AsyncGenerator[FakeConversationDb, None]:
        yield store

    monkeypatch.setattr(conversation_service_module, "get_session", _session)
    return store


class _CurrentUser:
    """The signed-in user, swappable mid-test so one client can be two people."""

    def __init__(self) -> None:
        self.id = USER_ID

    def __call__(self) -> UUID:
        return self.id


@pytest.fixture
def current_user() -> _CurrentUser:
    return _CurrentUser()


@pytest.fixture
def app_with_user(
    monkeypatch: pytest.MonkeyPatch, current_user: _CurrentUser
) -> Iterator[FastAPI]:
    from app.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    monkeypatch.setenv("RITHM_DEV_ENDPOINTS", "0")
    application = create_app()
    application.dependency_overrides[require_user] = current_user
    yield application
    get_settings.cache_clear()


@pytest_asyncio.fixture
async def client(app_with_user: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app_with_user), base_url="http://test"
    ) as http:
        yield http


@pytest.fixture(autouse=True)
def offline(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    BEDROCK_ENABLED defaults to False, so the scripted interviewer answers.
    Stated explicitly here rather than relied on: these tests are worthless if
    a stray environment variable quietly puts a network call on the path.
    """
    monkeypatch.setenv("BEDROCK_ENABLED", "false")
    agent._preferred_model_id = None  # pyright: ignore[reportPrivateUsage]


# ── GET /chat/session ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_bare_get_returns_an_empty_transcript_and_creates_no_row(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """An abandoned chat panel must not litter the table."""
    response = await client.get("/api/v1/chat/session")

    assert response.status_code == 200
    body = response.json()
    assert body["session_id"] is None
    assert body["messages"] == []
    assert body["ready"] is False
    assert body["draft"]["prompt"] is None
    assert db.sessions == []


@pytest.mark.asyncio
async def test_a_get_resumes_the_conversation(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    await client.post("/api/v1/chat/messages", json={"message": "a rainy drive"})

    body = (await client.get("/api/v1/chat/session")).json()

    assert body["session_id"] == str(db.sessions[0]["id"])
    assert [m["role"] for m in body["messages"]] == ["user", "assistant"]
    assert body["messages"][0]["content"] == "a rainy drive"
    assert body["draft"]["prompt"] == "a rainy drive"


# ── POST /chat/messages ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_first_message_creates_the_session(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    response = await client.post(
        "/api/v1/chat/messages", json={"message": "a rainy drive"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["message"]["role"] == "assistant"
    assert body["message"]["content"]
    assert body["ready"] is False
    assert len(db.sessions) == 1
    assert len(db.messages) == 2


@pytest.mark.asyncio
async def test_a_second_post_does_not_fork_the_transcript(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """
    Two tabs, a double-click, StrictMode's double effect. Without
    `sessions_one_active_per_user` this is two sessions and an assistant that
    has forgotten the first half of the conversation.
    """
    await client.post("/api/v1/chat/messages", json={"message": "a rainy drive"})
    await client.post("/api/v1/chat/messages", json={"message": "lo-fi"})

    assert len(db.sessions) == 1
    assert len(db.messages) == 4


@pytest.mark.asyncio
async def test_the_conversation_reaches_ready_and_fills_the_draft(
    client: AsyncClient,
) -> None:
    """
    Gate M3 through the HTTP surface. If this cannot get there, the feature is
    not buildable without AWS credentials.
    """
    body: dict[str, Any] = {}
    for message in ("a rainy late-night drive", "lo-fi", "calm", "instrumental"):
        body = (
            await client.post("/api/v1/chat/messages", json={"message": message})
        ).json()

    assert body["ready"] is True
    draft = body["draft"]
    assert draft["prompt"] == "a rainy late-night drive"
    assert draft["genre"] == "Lo-Fi"
    assert draft["mood"] == "Calm"
    assert draft["lyrics_mode"] == "instrumental"
    # Normalised on the way in, so the Create form cannot be handed a 422.
    assert draft["voice"] == "auto"


@pytest.mark.asyncio
async def test_ready_drives_the_session_state_column(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """READY_TO_EXPORT gates the DraftCard, so it is state and not decoration."""
    await client.post("/api/v1/chat/messages", json={"message": "a rainy drive"})
    assert db.sessions[0]["current_state"] == "DESCRIBING"

    for message in ("lo-fi", "calm", "instrumental"):
        await client.post("/api/v1/chat/messages", json={"message": message})

    assert db.sessions[0]["current_state"] == "READY_TO_EXPORT"


@pytest.mark.asyncio
async def test_the_turn_suggests_one_tap_answers_for_what_is_missing(
    client: AsyncClient,
) -> None:
    body = (
        await client.post("/api/v1/chat/messages", json={"message": "a rainy drive"})
    ).json()

    assert body["suggestions"] == ["Lo-Fi", "EDM", "Cinematic"]


@pytest.mark.asyncio
async def test_the_extracted_delta_is_stored_on_the_message(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """`tool_calls` is what makes "why did the draft move?" a SELECT."""
    await client.post("/api/v1/chat/messages", json={"message": "a rainy drive"})

    assistant = db.messages[1]
    assert assistant["role"] == "assistant"
    assert "draft_delta" in str(assistant["tool_calls"])


@pytest.mark.asyncio
async def test_an_empty_message_is_refused(client: AsyncClient) -> None:
    assert (
        await client.post("/api/v1/chat/messages", json={"message": "   "})
    ).status_code == 422


@pytest.mark.asyncio
async def test_an_overlong_message_is_refused(client: AsyncClient) -> None:
    """Every message is echoed back into the model's context on every turn."""
    response = await client.post("/api/v1/chat/messages", json={"message": "x" * 1001})

    assert response.status_code == 422


# ── Failure ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_failed_turn_leaves_the_users_message_persisted(
    client: AsyncClient, db: FakeConversationDb, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    A transcript that ends on an unanswered user turn is the honest record, and
    the SPA offers a retry. Rolling the turn back would silently eat what they
    typed.
    """

    async def _refuse(**_kwargs: Any) -> Any:
        raise AssistantUnavailableException()

    monkeypatch.setattr(agent, "run_turn", _refuse)

    response = await client.post(
        "/api/v1/chat/messages", json={"message": "a rainy drive"}
    )

    assert response.status_code == 503
    assert response.json()["type"] == "https://rithm.dev/errors/assistant-unavailable"
    assert response.headers["Retry-After"]
    assert [m["content"] for m in db.messages] == ["a rainy drive"]


# ── Caps ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_session_cap_is_a_409_with_its_own_problem_type(
    client: AsyncClient, db: FakeConversationDb, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    409, NOT 429. Nothing is rate-limited and waiting will not help — the fix
    is "Start over", and the SPA needs to tell the two apart to know which
    control to offer.
    """
    from app.config import get_settings

    monkeypatch.setenv("CHAT_MAX_MESSAGES_PER_SESSION", "1")
    get_settings.cache_clear()

    assert (
        await client.post("/api/v1/chat/messages", json={"message": "one"})
    ).status_code == 200
    response = await client.post("/api/v1/chat/messages", json={"message": "two"})

    assert response.status_code == 409
    assert response.json()["type"] == "https://rithm.dev/errors/chat-session-full"
    # The refused turn wrote nothing.
    assert [m["content"] for m in db.messages if m["role"] == "user"] == ["one"]


@pytest.mark.asyncio
async def test_starting_over_clears_the_session_cap(
    client: AsyncClient, db: FakeConversationDb, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Which is what makes 409 the right code: the fix is in the user's hands."""
    from app.config import get_settings

    monkeypatch.setenv("CHAT_MAX_MESSAGES_PER_SESSION", "1")
    get_settings.cache_clear()

    await client.post("/api/v1/chat/messages", json={"message": "one"})
    assert (await client.delete("/api/v1/chat/session")).status_code == 204
    response = await client.post("/api/v1/chat/messages", json={"message": "two"})

    assert response.status_code == 200
    assert len(db.sessions) == 2
    assert db.sessions[0]["deleted_at"] is not None


@pytest.mark.asyncio
async def test_the_daily_cap_is_a_429_and_creates_no_session(
    client: AsyncClient, db: FakeConversationDb, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    A real rate limit, so it reuses RateLimitExceededException as-is — and it
    is checked before the session is opened, so being refused does not leave an
    empty row behind.
    """
    from app.config import get_settings

    monkeypatch.setenv("CHAT_MAX_MESSAGES_PER_DAY", "1")
    get_settings.cache_clear()

    await client.post("/api/v1/chat/messages", json={"message": "one"})
    await client.delete("/api/v1/chat/session")
    sessions_before = len(db.sessions)
    response = await client.post("/api/v1/chat/messages", json={"message": "two"})

    assert response.status_code == 429
    assert response.headers["Retry-After"]
    assert response.json()["limit"] == 1
    assert len(db.sessions) == sessions_before


# ── Isolation ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_another_users_conversation_is_invisible(
    client: AsyncClient, db: FakeConversationDb, current_user: _CurrentUser
) -> None:
    """
    Not by an ownership check — by construction. No route takes a session id;
    every one of them resolves the caller's own session from require_user, so
    there is nothing to get wrong.
    """
    await client.post("/api/v1/chat/messages", json={"message": "a rainy drive"})

    current_user.id = OTHER_USER_ID
    body = (await client.get("/api/v1/chat/session")).json()

    assert body["session_id"] is None
    assert body["messages"] == []
    # And the first user's row is untouched.
    assert len(db.sessions) == 1


# ── DELETE /chat/session ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_is_idempotent_when_there_is_nothing_to_delete(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    assert (await client.delete("/api/v1/chat/session")).status_code == 204
    assert db.sessions == []


@pytest.mark.asyncio
async def test_delete_soft_deletes_and_keeps_the_transcript(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """
    Named, not solved: `messages` has no deleted_at and the FK cascades only on
    a hard delete, so these rows accumulate and want a retention job.
    """
    await client.post("/api/v1/chat/messages", json={"message": "a rainy drive"})

    await client.delete("/api/v1/chat/session")

    assert db.sessions[0]["deleted_at"] is not None
    assert len(db.messages) == 2
    assert (await client.get("/api/v1/chat/session")).json()["session_id"] is None


# ── History ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_history_is_truncated_by_token_budget_not_message_count(
    client: AsyncClient, db: FakeConversationDb, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    A fixed "last N messages" blows the context window the first time somebody
    pastes a verse. `messages.token_count` is documented on the column for
    exactly this.
    """
    from app.config import get_settings

    monkeypatch.setenv("CHAT_HISTORY_TOKEN_BUDGET", "12")
    get_settings.cache_clear()

    seen: list[int] = []
    real_history = conversation_service_module.ConversationService.history

    async def _spy(self: Any, **kwargs: Any) -> Any:
        messages = await real_history(self, **kwargs)
        seen.append(len(messages))
        return messages

    monkeypatch.setattr(
        conversation_service_module.ConversationService, "history", _spy
    )

    for _ in range(4):
        await client.post(
            "/api/v1/chat/messages", json={"message": "a long rainy midnight drive"}
        )

    assert all(count > 0 for count in seen)
    # The transcript outgrew the budget, so the window stopped following it.
    assert seen[-1] < len(db.messages)
    assert all(m["token_count"] is not None for m in db.messages)


@pytest.mark.asyncio
async def test_the_history_sent_to_the_model_is_oldest_first(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """It is walked newest-first to spend the budget, then reversed to be said."""
    captured: list[list[Any]] = []
    real_run_turn = agent.run_turn

    async def _spy(*, history: list[Any], draft: Any) -> Any:
        captured.append(history)
        return await real_run_turn(history=history, draft=draft)

    monkeypatch.setattr(agent, "run_turn", _spy)

    await client.post("/api/v1/chat/messages", json={"message": "first"})
    await client.post("/api/v1/chat/messages", json={"message": "second"})

    last = captured[-1]
    assert last[0]["content"][0]["text"] == "first"
    assert last[-1]["content"][0]["text"] == "second"
    assert last[-1]["role"] == "user"


@pytest.mark.asyncio
async def test_a_session_id_is_never_taken_from_the_client() -> None:
    """
    The reason the isolation test above is short: there is no id to tamper
    with. If a path parameter ever appears on these routes, this fails and
    somebody has to write an ownership check.
    """
    from app.main import create_app

    paths = [
        str(getattr(route, "path", ""))
        for route in create_app().routes
        if "/chat/" in str(getattr(route, "path", ""))
    ]

    assert paths
    assert not any("{" in path for path in paths)


@pytest.mark.asyncio
async def test_the_fake_database_is_actually_being_exercised(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """Guard against the store silently answering nothing at all."""
    await client.post("/api/v1/chat/messages", json={"message": "a rainy drive"})

    assert any(s.startswith("INSERT INTO conversation.sessions") for s in db.statements)
    assert any("ON CONFLICT DO NOTHING" in s for s in db.statements)
    assert any("CAST(:draft AS JSONB)" in s for s in db.statements)


# ── Voice, through the chat door ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_voice_available_tracks_the_setting_in_both_directions(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    How the SPA learns voice exists without spending the one global Anam slot
    to find out. Both directions, because the interesting one is `false`: it is
    what keeps today's panel — Lottie, StreamingPrompt, Talk to Coming Soon —
    bit-for-bit in every environment without a key.
    """
    from app.config import get_settings

    # BOTH directions pinned explicitly. `Settings` reads `env_file=".env"`, so
    # relying on the ambient default for the `false` half makes this test pass
    # or fail depending on whether the developer has switched voice on locally.
    monkeypatch.setenv("ANAM_ENABLED", "false")
    get_settings.cache_clear()
    try:
        body = (await client.get("/api/v1/chat/session")).json()
        assert body["voice_available"] is False

        monkeypatch.setenv("ANAM_ENABLED", "true")
        get_settings.cache_clear()
        body = (await client.get("/api/v1/chat/session")).json()
        assert body["voice_available"] is True
    finally:
        monkeypatch.delenv("ANAM_ENABLED", raising=False)
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_source_defaults_to_chat_so_an_older_client_still_works(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """
    The deploy window. An SPA that predates voice posts no `source` at all, and
    it must keep working — and must not mark the session voice-enabled.
    """
    response = await client.post(
        "/api/v1/chat/messages", json={"message": "a rainy drive"}
    )

    assert response.status_code == 200
    assert db.sessions[0]["voice_enabled"] is False


@pytest.mark.asyncio
async def test_a_voice_turn_marks_the_session_voice_enabled(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """
    `sessions.voice_enabled` has existed since the baseline migration and has
    never had a writer. This is it — and it needs no DDL.
    """
    await client.post(
        "/api/v1/chat/messages",
        json={"message": "a rainy drive", "source": "voice"},
    )

    assert db.sessions[0]["voice_enabled"] is True


@pytest.mark.asyncio
async def test_the_voice_flag_is_sticky_across_a_typed_turn(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """
    Two doors, ONE conversation. A session held half by voice and half by
    typing was still a voice conversation; the Chat door must not erase that.
    """
    await client.post(
        "/api/v1/chat/messages",
        json={"message": "a rainy drive", "source": "voice"},
    )
    await client.post("/api/v1/chat/messages", json={"message": "lo-fi"})

    assert db.sessions[0]["voice_enabled"] is True


@pytest.mark.asyncio
async def test_an_unknown_source_is_refused(client: AsyncClient) -> None:
    """A Literal, not a free string: the log line and the column both read it."""
    response = await client.post(
        "/api/v1/chat/messages", json={"message": "hi", "source": "telepathy"}
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_a_voice_turn_runs_the_same_agent_and_fills_the_same_draft(
    client: AsyncClient,
) -> None:
    """
    THE CENTRAL DESIGN DECISION, asserted on the server side. Anam is a face
    and a voice; the transport is the only thing `source` changes.
    """
    turn = await client.post(
        "/api/v1/chat/messages",
        json={"message": "a rainy drive through neon streets", "source": "voice"},
    )

    body = turn.json()
    assert body["message"]["role"] == "assistant"
    assert body["draft"]["prompt"] == "a rainy drive through neon streets"

    # And it is in the SAME transcript the Chat door reads.
    resumed = (await client.get("/api/v1/chat/session")).json()
    assert [m["role"] for m in resumed["messages"]] == ["user", "assistant"]


# ── POST /chat/turns/record ─────────────────────────────────────────────────
#
# The counterweight to giving Anam the brain. The avatar answers on its own, so
# these are the tests that prove the product did not go with it: the transcript
# Chat reads, and the SongDraft that pre-fills Create, are still built here.


RECORD_URL = "/api/v1/chat/turns/record"


@pytest.mark.asyncio
async def test_recording_writes_both_sides_into_the_transcript(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """
    BOTH ROLES, because Anam wrote the reply and nothing else will.

    On the old path the assistant's line was generated here, so recording only
    the user's was enough. Now the persona's rows are the only copy that
    exists — drop them and Chat shows a transcript with holes in it, which is
    exactly the failure the whole design was built to avoid.
    """
    response = await client.post(
        RECORD_URL,
        json={
            "turns": [
                {"role": "user", "content": "something for a late night drive"},
                {"role": "assistant", "content": "Nice — what genre fits?"},
            ]
        },
    )

    assert response.status_code == 200
    assert [(m["role"], m["content"]) for m in db.messages] == [
        ("user", "something for a late night drive"),
        ("assistant", "Nice — what genre fits?"),
    ]


@pytest.mark.asyncio
async def test_recording_advances_the_draft(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """
    THE ASSERTION THIS WHOLE ROUTE EXISTS FOR.

    Anam's model may say "synthwave" and never map it to the closed list. What
    lands in the draft still goes through `SongDraft` validation, so the RECORD
    stays correct even when the conversation wanders — and that record is what
    opens the Create door.
    """
    response = await client.post(
        RECORD_URL,
        json={"turns": [{"role": "user", "content": "hip-hop, something dark"}]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["draft"]["genre"] == "Hip-Hop"
    assert body["draft"]["mood"] == "Dark"
    # Persisted, not just returned — the session GET reads this row. The fake
    # stores what the CAST(:draft AS JSONB) bind was given, i.e. the JSON text.
    assert json.loads(db.sessions[0]["draft"])["genre"] == "Hip-Hop"


@pytest.mark.asyncio
async def test_recording_marks_the_session_voice_enabled(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """Everything through this route is voice by definition."""
    await client.post(
        RECORD_URL, json={"turns": [{"role": "user", "content": "a rainy drive"}]}
    )

    assert db.sessions[0]["voice_enabled"] is True


@pytest.mark.asyncio
async def test_recording_never_returns_a_reply_or_chips(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """
    There is no reply to return and no question this server asked, so there are
    no chips to answer it with. Shipping either would be inventing a turn.
    """
    body = (
        await client.post(
            RECORD_URL, json={"turns": [{"role": "user", "content": "pop, happy"}]}
        )
    ).json()

    assert set(body) == {"draft", "ready"}


@pytest.mark.asyncio
async def test_a_recorded_conversation_reads_back_from_the_session_get(
    client: AsyncClient, db: FakeConversationDb
) -> None:
    """
    TALK AND CHAT REMAIN TWO DOORS ON ONE CONVERSATION.

    The record path writes the same session row `/chat/messages` writes, so
    somebody who talks and then opens Chat finds what they said — which is the
    property that makes the vendor's brain survivable.
    """
    await client.post(
        RECORD_URL,
        json={
            "turns": [
                {"role": "user", "content": "lo-fi, calm"},
                {"role": "assistant", "content": "Lo-Fi and calm — good."},
            ]
        },
    )

    session = (await client.get("/api/v1/chat/session")).json()
    assert [m["content"] for m in session["messages"]] == [
        "lo-fi, calm",
        "Lo-Fi and calm — good.",
    ]
    assert session["draft"]["genre"] == "Lo-Fi"


@pytest.mark.asyncio
async def test_recording_refuses_once_the_session_is_full(
    client: AsyncClient, db: FakeConversationDb, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    409, the same refusal `/chat/messages` gives, so the client's existing
    handling ends the call rather than holding the one global Anam slot open
    for a server that will refuse the next turn too.
    """
    from app.config import get_settings

    monkeypatch.setenv("CHAT_MAX_MESSAGES_PER_SESSION", "1")
    get_settings.cache_clear()
    try:
        first = await client.post(
            RECORD_URL, json={"turns": [{"role": "user", "content": "pop"}]}
        )
        assert first.status_code == 200

        second = await client.post(
            RECORD_URL, json={"turns": [{"role": "user", "content": "happy"}]}
        )
        assert second.status_code == 409
    finally:
        monkeypatch.delenv("CHAT_MAX_MESSAGES_PER_SESSION", raising=False)
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_recording_rejects_an_empty_batch(client: AsyncClient) -> None:
    """`min_length=1`. An empty POST is a client bug, not a quiet no-op."""
    assert (await client.post(RECORD_URL, json={"turns": []})).status_code == 422


@pytest.mark.asyncio
async def test_recording_rejects_a_blank_turn(client: AsyncClient) -> None:
    """
    STT emits empties on a cough. The client already guards, and so does this:
    `str_strip_whitespace` plus `min_length=1` makes whitespace a 422 rather
    than a blank bubble in the transcript.
    """
    response = await client.post(
        RECORD_URL, json={"turns": [{"role": "user", "content": "   "}]}
    )

    assert response.status_code == 422
