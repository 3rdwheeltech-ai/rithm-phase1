"""
POST/DELETE /chat/voice/session — the vendor boundary, the one global slot, and
everything that must never leak out of either.

WITH ANAM DISABLED — the default, and what CI runs — the route 501s before it
makes a single outbound request, which is free coverage of the not-configured
path exactly as `bedrock_enabled: False` gives today.

`httpx_mock` follows the `test_sns_handler.py` precedent. Worth stating for the
next reader: pytest-httpx patches `AsyncHTTPTransport`, NOT `ASGITransport`, so
the `async_client` fixture passes through untouched — which is why the SNS test
works and why this one does too.
"""

from collections.abc import AsyncIterator, Iterator
from typing import Any, cast
from uuid import UUID

import httpx
import pytest
import pytest_asyncio
import structlog
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pytest_httpx import HTTPXMock

from app.modules.conversation import lease as lease_module
from app.modules.conversation.lease import voice_lease, voice_starts
from app.shared.auth import require_user

USER_ID = UUID("00000000-0000-7000-8000-0000000000d1")
OTHER_USER_ID = UUID("00000000-0000-7000-8000-0000000000d2")

TOKEN = "anam-session-token-that-must-never-be-logged"
API_KEY = "anam-api-key-that-must-never-be-logged"
VOICE_ID = "voice-tara-confident-ally"

TOKEN_URL = "https://api.anam.ai/v1/auth/session-token"


class _CurrentUser:
    """The signed-in user, swappable mid-test so one client can be two people."""

    def __init__(self) -> None:
        self.id = USER_ID

    def __call__(self) -> UUID:
        return self.id


@pytest.fixture
def current_user() -> _CurrentUser:
    return _CurrentUser()


@pytest_asyncio.fixture(autouse=True)
async def clean_slot() -> AsyncIterator[None]:
    """
    The lease and the start counter are module singletons, i.e. process state.

    Reset on BOTH sides: a test that leaves the slot held would 429 every test
    after it, and the failure would land somewhere unrelated.
    """
    await voice_lease.reset()
    await voice_starts.reset()
    yield
    await voice_lease.reset()
    await voice_starts.reset()


@pytest.fixture
def anam_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """
    ANAM_ENABLED on, with a key and a voice id.

    Set explicitly rather than relied on: these tests are worthless if a stray
    environment variable quietly changes which branch runs.
    """
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("ANAM_ENABLED", "true")
    monkeypatch.setenv("ANAM_API_KEY", API_KEY)
    monkeypatch.setenv("ANAM_VOICE_ID", VOICE_ID)
    monkeypatch.setenv("ANAM_LLM_ID", "CUSTOMER_CLIENT_V1")
    yield
    for name in ("ANAM_ENABLED", "ANAM_API_KEY", "ANAM_VOICE_ID", "ANAM_LLM_ID"):
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()


@pytest.fixture
def app_with_user(
    monkeypatch: pytest.MonkeyPatch, current_user: _CurrentUser
) -> Iterator[FastAPI]:
    from app.config import get_settings
    from app.main import create_app

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


@pytest_asyncio.fixture
async def anon_client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    """No dependency override — `require_user` runs for real."""
    from app.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("RITHM_DEV_ENDPOINTS", "0")
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as http:
        yield http
    get_settings.cache_clear()


def mint_ok(httpx_mock: HTTPXMock, token: str = TOKEN) -> None:
    httpx_mock.add_response(url=TOKEN_URL, json={"sessionToken": token})


def sent_body(httpx_mock: HTTPXMock) -> dict[str, Any]:
    """
    What we actually put on the wire.

    Annotated `object` then cast, not left as json.loads's `Any`: under pyright
    strict a bare `isinstance(x, dict)` narrows to `dict[Unknown, Unknown]`,
    which is a fresh error against a baseline that has no room in it.
    """
    import json

    request = httpx_mock.get_requests()[0]
    parsed: object = json.loads(request.content)
    assert isinstance(parsed, dict)
    return cast(dict[str, Any], parsed)


# ── Auth and configuration ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_requires_authentication(
    anon_client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    """It spends money and takes the one global slot. It is not a public route."""
    response = await anon_client.post("/api/v1/chat/voice/session")

    assert response.status_code == 401
    assert httpx_mock.get_requests() == []


@pytest.mark.asyncio
async def test_disabled_by_default_makes_no_outbound_request(
    client: AsyncClient, httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    501, not 404 and not 403 — the route exists and the caller did nothing
    wrong. The check comes FIRST, so a deployment with no key costs zero
    outbound requests.

    ANAM_ENABLED IS PINNED OFF rather than assumed off. `Settings` reads
    `env_file=".env"`, so a developer who has switched voice on locally would
    otherwise watch this test try a real mint against a real key and fail on
    their machine while passing in CI.
    """
    from app.config import get_settings

    monkeypatch.setenv("ANAM_ENABLED", "false")
    get_settings.cache_clear()
    try:
        response = await client.post("/api/v1/chat/voice/session")
        assert response.status_code == 501
        assert (
            response.json()["type"] == "https://rithm.dev/errors/voice-not-configured"
        )
        assert httpx_mock.get_requests() == []
    finally:
        monkeypatch.delenv("ANAM_ENABLED", raising=False)
        get_settings.cache_clear()


# ── The persona config ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sends_persona_config_and_never_a_persona_id(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    """
    A saved persona carries its OWN llmId, set in a web console that is not in
    git and not reviewed. Referencing one would hand us the vendor's brain back.
    """
    mint_ok(httpx_mock)

    await client.post("/api/v1/chat/voice/session")

    body = sent_body(httpx_mock)
    assert "personaConfig" in body
    assert "personaId" not in body
    persona: object = body["personaConfig"]
    assert isinstance(persona, dict)
    assert "personaId" not in persona
    assert persona["voiceId"] == VOICE_ID


@pytest.mark.asyncio
async def test_the_persona_config_disables_anams_own_llm(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    """
    THE SINGLE MOST IMPORTANT ASSERTION IN THIS FEATURE.

    It is what stands between the product and the avatar quietly growing its
    own brain — a failure with no error, no 500 and no alarm, just a DraftCard
    that never fills and a transcript with a hole in it.

    Anam's own model was tried here and reverted. It was not subtle about it —
    a minute of scene-painting a turn — but the reason it can never sit in this
    seat is quieter: it cannot see the draft, so it re-asks what it already has.
    """
    mint_ok(httpx_mock)

    await client.post("/api/v1/chat/voice/session")

    persona: object = sent_body(httpx_mock)["personaConfig"]
    assert isinstance(persona, dict)
    assert persona["llmId"] == "CUSTOMER_CLIENT_V1"


@pytest.mark.asyncio
async def test_no_system_prompt_is_sent(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    """
    Two prompts that each think they run the interview is exactly the drift
    agent.py's rules exist to prevent. Director Notes are the field if delivery
    ever needs shaping.
    """
    mint_ok(httpx_mock)

    await client.post("/api/v1/chat/voice/session")

    persona: object = sent_body(httpx_mock)["personaConfig"]
    assert isinstance(persona, dict)
    assert "systemPrompt" not in persona


@pytest.mark.asyncio
async def test_the_api_key_goes_in_the_header_and_never_in_the_response(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    mint_ok(httpx_mock)

    response = await client.post("/api/v1/chat/voice/session")

    request = httpx_mock.get_requests()[0]
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert API_KEY not in response.text
    assert response.json()["session_token"] == TOKEN


@pytest.mark.asyncio
async def test_the_token_is_never_cached(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    """It outlives its usefulness by twenty times. Nothing may keep it."""
    mint_ok(httpx_mock)

    response = await client.post("/api/v1/chat/voice/session")

    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.asyncio
async def test_the_cap_comes_from_settings_not_from_a_hardcoded_180(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    """The SPA's countdown runs off this number, so it is a server fact."""
    from app.config import get_settings

    mint_ok(httpx_mock)

    response = await client.post("/api/v1/chat/voice/session")

    assert response.json()["expires_in_seconds"] == get_settings().anam_session_seconds


# ── Vendor failures ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_anam_429_becomes_voice_at_capacity_with_a_retry_after(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(url=TOKEN_URL, status_code=429, json={"error": "busy"})

    response = await client.post("/api/v1/chat/voice/session")

    assert response.status_code == 429
    body = response.json()
    assert body["type"] == "https://rithm.dev/errors/voice-at-capacity"
    assert body["retry_after_seconds"] > 0
    assert response.headers["Retry-After"] == str(body["retry_after_seconds"])


@pytest.mark.asyncio
async def test_anam_5xx_becomes_voice_unavailable_and_leaks_no_vendor_text(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    """
    The vendor's error body is a third party's text about a third party's
    service. The SPA has one job with it: fall back to the Lottie.
    """
    httpx_mock.add_response(
        url=TOKEN_URL,
        status_code=502,
        json={"error": "upstream persona renderer exploded", "traceId": "abc123"},
    )

    response = await client.post("/api/v1/chat/voice/session")

    assert response.status_code == 503
    assert response.json()["type"] == "https://rithm.dev/errors/voice-unavailable"
    assert "renderer" not in response.text
    assert "abc123" not in response.text


@pytest.mark.asyncio
async def test_an_empty_session_token_is_treated_as_a_refusal(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    """A 2xx that carries no usable token is a refusal, not a success."""
    httpx_mock.add_response(url=TOKEN_URL, json={"sessionToken": ""})

    response = await client.post("/api/v1/chat/voice/session")

    assert response.status_code == 503


@pytest.mark.asyncio
async def test_a_missing_session_token_is_treated_as_a_refusal(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(url=TOKEN_URL, json={"ok": True})

    response = await client.post("/api/v1/chat/voice/session")

    assert response.status_code == 503


@pytest.mark.asyncio
async def test_a_timeout_is_not_retried(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    """
    Guards the no-retry decision. The failure this call actually has is
    CAPACITY, which retrying makes worse — and against a one-session plan a
    double mint competes with itself for the slot it just lost.
    """
    httpx_mock.add_exception(httpx.ReadTimeout("too slow"), url=TOKEN_URL)

    response = await client.post("/api/v1/chat/voice/session")

    assert response.status_code == 503
    assert len(httpx_mock.get_requests()) == 1


# ── The one slot ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_second_user_is_refused_while_a_lease_is_held(
    client: AsyncClient,
    anam_env: None,
    httpx_mock: HTTPXMock,
    current_user: _CurrentUser,
) -> None:
    """
    The free tier's one concurrent session is a property of the API KEY, so
    without arbitration this is a bare vendor 429 with no computable wait.
    """
    mint_ok(httpx_mock)
    first = await client.post("/api/v1/chat/voice/session")
    assert first.status_code == 201

    current_user.id = OTHER_USER_ID
    second = await client.post("/api/v1/chat/voice/session")

    assert second.status_code == 429
    assert second.json()["type"] == "https://rithm.dev/errors/voice-at-capacity"
    assert second.json()["retry_after_seconds"] > 0
    # Refused HERE, not at the vendor: only one mint ever left the process.
    assert len(httpx_mock.get_requests()) == 1


@pytest.mark.asyncio
async def test_the_same_user_reclaims_their_own_lease(
    client: AsyncClient, anam_env: None, httpx_mock: HTTPXMock
) -> None:
    """
    A reload mid-session must not lock someone out of a slot they are already
    holding — and React.StrictMode's double effect would otherwise 429 the
    second half of every start in development.
    """
    mint_ok(httpx_mock)
    httpx_mock.add_response(url=TOKEN_URL, json={"sessionToken": "second-token"})

    first = await client.post("/api/v1/chat/voice/session")
    second = await client.post("/api/v1/chat/voice/session")

    assert first.status_code == 201
    assert second.status_code == 201
    # A NEW lease id, which is what makes the stale tab's DELETE a no-op.
    assert second.json()["lease_id"] != first.json()["lease_id"]


@pytest.mark.asyncio
async def test_releasing_the_lease_lets_the_next_user_in(
    client: AsyncClient,
    anam_env: None,
    httpx_mock: HTTPXMock,
    current_user: _CurrentUser,
) -> None:
    mint_ok(httpx_mock)
    httpx_mock.add_response(url=TOKEN_URL, json={"sessionToken": "second-token"})

    first = await client.post("/api/v1/chat/voice/session")
    lease_id = first.json()["lease_id"]

    released = await client.delete(f"/api/v1/chat/voice/session?lease_id={lease_id}")
    assert released.status_code == 204

    current_user.id = OTHER_USER_ID
    second = await client.post("/api/v1/chat/voice/session")
    assert second.status_code == 201


@pytest.mark.asyncio
async def test_releasing_a_lease_nobody_holds_is_still_204(
    client: AsyncClient, anam_env: None
) -> None:
    """Idempotent: no lease is already the desired end state."""
    response = await client.delete(
        "/api/v1/chat/voice/session?lease_id=00000000-0000-7000-8000-00000000dead"
    )

    assert response.status_code == 204


@pytest.mark.asyncio
async def test_a_stale_lease_id_cannot_release_the_current_holder(
    client: AsyncClient,
    anam_env: None,
    httpx_mock: HTTPXMock,
    current_user: _CurrentUser,
) -> None:
    """
    Reclaiming hands the same user a NEW lease id, so an old tab's `pagehide`
    arrives carrying one that is genuinely no longer current. It must not free
    the slot the live tab is holding.
    """
    mint_ok(httpx_mock)
    httpx_mock.add_response(url=TOKEN_URL, json={"sessionToken": "second-token"})

    stale = (await client.post("/api/v1/chat/voice/session")).json()["lease_id"]
    await client.post("/api/v1/chat/voice/session")  # reclaim, new lease id

    await client.delete(f"/api/v1/chat/voice/session?lease_id={stale}")

    current_user.id = OTHER_USER_ID
    assert (await client.post("/api/v1/chat/voice/session")).status_code == 429


@pytest.mark.asyncio
async def test_a_lease_expires_without_a_delete(
    client: AsyncClient,
    anam_env: None,
    httpx_mock: HTTPXMock,
    current_user: _CurrentUser,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    The TTL is the REAL guarantee. The client's release runs on `pagehide`
    through fetch(keepalive), which Firefox before 133 does not implement at
    all — so the recovery story cannot be built on it.
    """
    mint_ok(httpx_mock)
    httpx_mock.add_response(url=TOKEN_URL, json={"sessionToken": "second-token"})

    assert (await client.post("/api/v1/chat/voice/session")).status_code == 201

    real_now = lease_module._now()  # pyright: ignore[reportPrivateUsage]
    monkeypatch.setattr(lease_module, "_now", lambda: real_now + 10_000)

    current_user.id = OTHER_USER_ID
    assert (await client.post("/api/v1/chat/voice/session")).status_code == 201


@pytest.mark.asyncio
async def test_a_failed_mint_does_not_park_the_slot(
    client: AsyncClient,
    anam_env: None,
    httpx_mock: HTTPXMock,
    current_user: _CurrentUser,
) -> None:
    """
    Claim before minting, release in the failure path — or a vendor outage
    holds the product's only slot for the full three minutes.
    """
    httpx_mock.add_response(url=TOKEN_URL, status_code=500, json={})
    assert (await client.post("/api/v1/chat/voice/session")).status_code == 503

    httpx_mock.add_response(url=TOKEN_URL, json={"sessionToken": TOKEN})
    current_user.id = OTHER_USER_ID
    assert (await client.post("/api/v1/chat/voice/session")).status_code == 201


# ── The daily cap ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_daily_session_cap_is_enforced_per_user(
    client: AsyncClient,
    anam_env: None,
    httpx_mock: HTTPXMock,
    current_user: _CurrentUser,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cap on STARTS, not turns: one user must not churn through the budget."""
    from app.config import get_settings

    monkeypatch.setenv("ANAM_MAX_SESSIONS_PER_USER_PER_DAY", "2")
    get_settings.cache_clear()

    httpx_mock.add_response(
        url=TOKEN_URL, json={"sessionToken": TOKEN}, is_reusable=True
    )

    for _ in range(2):
        assert (await client.post("/api/v1/chat/voice/session")).status_code == 201

    refused = await client.post("/api/v1/chat/voice/session")
    assert refused.status_code == 429
    assert refused.json()["type"] == "https://rithm.dev/errors/voice-quota-exceeded"

    # Per USER, not global: someone else still gets in once the slot is free.
    await voice_lease.reset()
    current_user.id = OTHER_USER_ID
    assert (await client.post("/api/v1/chat/voice/session")).status_code == 201

    monkeypatch.delenv("ANAM_MAX_SESSIONS_PER_USER_PER_DAY", raising=False)
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_a_failed_mint_does_not_spend_a_daily_start(
    client: AsyncClient,
    anam_env: None,
    httpx_mock: HTTPXMock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    A session that never started is not a start. Charging a user for a vendor
    outage is the app reading as broken twice.
    """
    from app.config import get_settings

    monkeypatch.setenv("ANAM_MAX_SESSIONS_PER_USER_PER_DAY", "1")
    get_settings.cache_clear()

    httpx_mock.add_response(url=TOKEN_URL, status_code=500, json={})
    assert (await client.post("/api/v1/chat/voice/session")).status_code == 503

    httpx_mock.add_response(url=TOKEN_URL, json={"sessionToken": TOKEN})
    assert (await client.post("/api/v1/chat/voice/session")).status_code == 201

    monkeypatch.delenv("ANAM_MAX_SESSIONS_PER_USER_PER_DAY", raising=False)
    get_settings.cache_clear()


# ── Logging ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_token_is_never_logged(
    client: AsyncClient,
    anam_env: None,
    httpx_mock: HTTPXMock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    agent.py rule 3, extended: lengths, counts, flags, status codes and session
    ids only. Never the token, never the key, never a word anyone said.

    The two module loggers are swapped for fresh proxies rather than relying on
    `structlog.configure` alone: `configure_logging` sets
    `cache_logger_on_first_use=True`, so a proxy that any earlier test in the
    run has already bound keeps its OLD configuration and this capture sees
    nothing. Isolated, the test passed either way — which is precisely the kind
    of green that means nothing.
    """
    from app.modules.conversation import anam as anam_module
    from app.modules.conversation import api as api_module

    mint_ok(httpx_mock)
    captured = structlog.testing.LogCapture()
    structlog.configure(processors=[captured])
    monkeypatch.setattr(anam_module, "logger", structlog.get_logger())
    monkeypatch.setattr(api_module, "logger", structlog.get_logger())

    try:
        await client.post("/api/v1/chat/voice/session")
    finally:
        structlog.reset_defaults()

    rendered = repr(captured.entries)
    assert TOKEN not in rendered
    assert API_KEY not in rendered

    minted = [e for e in captured.entries if e["event"] == "anam_token_minted"]
    assert len(minted) == 1
    assert minted[0]["ok"] is True
    assert minted[0]["status"] == 200

