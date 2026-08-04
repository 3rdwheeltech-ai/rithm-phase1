"""
SSE endpoint tests.

Testing constraint worth stating once: neither httpx's ASGITransport nor
Starlette's TestClient can observe a stream incrementally — both accumulate the
whole body before building the Response. So streams that *terminate* are tested
through the client, and streams that *don't* are tested by driving the
generator directly.
"""

import asyncio
from typing import Any

import pytest
from httpx import AsyncClient

from app.config import get_settings
from app.modules.generation import api as generation_api
from app.modules.generation.schemas import SSEEvent
from app.modules.generation.sse_hub import SSEHub
from app.modules.generation.sse_token import mint

_JOB = "01920000-0000-7000-8000-00000000abcd"
_UID = "00000000-0000-7000-8000-000000000001"


def _token(job_id: str = _JOB, ttl: int = 300) -> str:
    key = get_settings().sse_token_secret.get_secret_value()
    return mint(_UID, job_id, key, ttl)


@pytest.mark.asyncio
async def test_missing_token_is_422(async_client: AsyncClient) -> None:
    response = await async_client.get(f"/api/v1/jobs/{_JOB}/events")
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_bad_signature_is_401(async_client: AsyncClient) -> None:
    body, _, _ = _token().partition(".")
    response = await async_client.get(
        f"/api/v1/jobs/{_JOB}/events", params={"token": f"{body}.forged"}
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_expired_token_is_401_with_a_distinguishable_type(
    async_client: AsyncClient,
) -> None:
    """
    Expiry must be tellable from every other 401.

    EventSource does not expose the response status on error, so a stranded
    client probes this URL with a plain fetch purely to read it. On this exact
    `type` it stops reconnecting and falls back to polling; on a generic 401 it
    concludes it is logged out and sends the user to /login mid-generation.
    """
    response = await async_client.get(
        f"/api/v1/jobs/{_JOB}/events", params={"token": _token(ttl=-1)}
    )
    assert response.status_code == 401
    assert response.json()["type"] == "https://rithm.dev/errors/sse-token-expired"


@pytest.mark.asyncio
async def test_token_job_mismatch_is_401(async_client: AsyncClient) -> None:
    other = "01920000-0000-7000-8000-0000000fffff"
    response = await async_client.get(
        f"/api/v1/jobs/{_JOB}/events", params={"token": _token(job_id=other)}
    )
    assert response.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("token_factory", ["forged", "mismatch"])
async def test_only_expiry_gets_the_expiry_type(
    async_client: AsyncClient, token_factory: str
) -> None:
    """A bad signature or a wrong job is not recoverable by polling."""
    if token_factory == "forged":
        body, _, _ = _token().partition(".")
        token = f"{body}.forged"
    else:
        token = _token(job_id="01920000-0000-7000-8000-0000000fffff")

    response = await async_client.get(
        f"/api/v1/jobs/{_JOB}/events", params={"token": token}
    )
    assert response.status_code == 401
    assert response.json()["type"] == "https://rithm.dev/errors/401"


@pytest.mark.asyncio
async def test_sse_token_ttl_comes_from_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    The TTL is read from Settings, not a literal — that is what makes
    SSE_TOKEN_TTL_SECONDS in the taskdef do anything. Default is 1800: a cold
    start is minutes, and a 5-minute token is shorter than the wait it covers.
    """
    from app.config import Settings

    assert Settings.model_fields["sse_token_ttl_seconds"].default == 1800

    monkeypatch.setenv("SSE_TOKEN_TTL_SECONDS", "77")
    get_settings.cache_clear()
    try:
        assert get_settings().sse_token_ttl_seconds == 77
    finally:
        monkeypatch.delenv("SSE_TOKEN_TTL_SECONDS", raising=False)
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_terminal_state_replays_and_closes(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A job already COMPLETED in the DB replays one frame and closes."""
    completed: SSEEvent = {
        "event": "completed",
        "data": {
            "job_id": _JOB,
            "s3_mp3_key": "tracks/u/j/audio.mp3",
            "s3_wav_key": "tracks/u/j/master.wav",
            "duration_seconds": 30,
        },
    }

    async def fake_load(_job_id: str) -> SSEEvent:
        return completed

    monkeypatch.setattr(generation_api.generation_service, "load_job_event", fake_load)

    response = await async_client.get(
        f"/api/v1/jobs/{_JOB}/events", params={"token": _token()}
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    assert response.text.startswith("event: completed\ndata: {")
    assert response.text.endswith("\n\n")
    assert '"s3_mp3_key": "tracks/u/j/audio.mp3"' in response.text


@pytest.mark.asyncio
async def test_stream_heartbeats_then_closes_on_terminal_event(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    Drive the generator directly: queued replay → keepalive → live failed
    event → close and unsubscribe.
    """
    monkeypatch.setattr(generation_api, "_HEARTBEAT_SECONDS", 0.05)

    async def fake_load(_job_id: str) -> SSEEvent:
        return {"event": "queued", "data": {"job_id": _JOB}}

    monkeypatch.setattr(generation_api.generation_service, "load_job_event", fake_load)

    stream = generation_api._event_stream(hub, _JOB)
    assert await stream.__anext__() == (
        f'event: queued\ndata: {{"job_id": "{_JOB}"}}\n\n'
    )
    assert await stream.__anext__() == "event: keepalive\ndata: {}\n\n"

    failed: SSEEvent = {
        "event": "failed",
        "data": {"job_id": _JOB, "error": "boom"},
    }
    hub.publish(_JOB, failed)
    frame = await stream.__anext__()
    assert frame.startswith("event: failed\n")

    with pytest.raises(StopAsyncIteration):
        await stream.__anext__()
    assert hub.subscriber_count(_JOB) == 0


@pytest.mark.asyncio
async def test_stream_subscribes_before_reading_state(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    The lost-wakeup guard: an event published *while* the DB read is in flight
    must still be delivered. That only holds if subscribe() happens first.
    """
    monkeypatch.setattr(generation_api, "_HEARTBEAT_SECONDS", 0.05)
    running: SSEEvent = {
        "event": "running",
        "data": {"job_id": _JOB, "started_at": None},
    }

    async def slow_load(_job_id: str) -> SSEEvent | None:
        # Publish during the read — the window the ordering exists to close.
        hub.publish(_JOB, running)
        await asyncio.sleep(0)
        return None

    monkeypatch.setattr(generation_api.generation_service, "load_job_event", slow_load)

    stream = generation_api._event_stream(hub, _JOB)
    assert (await stream.__anext__()).startswith("event: running\n")
    await stream.aclose()


@pytest.mark.asyncio
async def test_stream_unsubscribes_when_closed_early(
    hub: SSEHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Client disconnect closes the generator; the finally must clean up."""
    monkeypatch.setattr(generation_api, "_HEARTBEAT_SECONDS", 0.05)

    async def fake_load(_job_id: str) -> Any:
        return None

    monkeypatch.setattr(generation_api.generation_service, "load_job_event", fake_load)

    stream = generation_api._event_stream(hub, _JOB)
    assert await stream.__anext__() == "event: keepalive\ndata: {}\n\n"
    assert hub.subscriber_count(_JOB) == 1
    await stream.aclose()
    assert hub.subscriber_count(_JOB) == 0
