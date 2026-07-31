"""
Dev-enqueue route — the load-bearing write path for Gate C.

SQS is verified by capturing what send_sqs_message was handed. moto or a real
LocalStack round-trip would be testing botocore; what matters here is that the
envelope matches §2.1 exactly, because the Day-2 worker is being built to parse
it.
"""
import json
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.config import get_settings
from app.modules.generation import service as generation_service_module
from app.modules.generation.sse_token import verify
from tests.conftest import FakeSession

_PATH = "/internal/dev/enqueue-test-job"
_SYNTHETIC_USER = "00000000-0000-7000-8000-000000000001"


@pytest.fixture
def sqs_messages(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def _capture(
        *,
        queue_url: str,
        body: str,
        attributes: dict[str, dict[str, str]] | None = None,
    ) -> str:
        sent.append(
            {
                "queue_url": queue_url,
                "body": json.loads(body),
                "attributes": attributes,
            }
        )
        return "msg-1"

    monkeypatch.setattr(
        generation_service_module, "send_sqs_message", _capture
    )
    return sent


@pytest.fixture
def db_sessions(monkeypatch: pytest.MonkeyPatch) -> list[FakeSession]:
    sessions: list[FakeSession] = []

    @asynccontextmanager
    async def _session(_module: str) -> Any:
        session = FakeSession()
        sessions.append(session)
        yield session

    monkeypatch.setattr(generation_service_module, "get_session", _session)
    return sessions


@pytest.mark.asyncio
async def test_route_absent_when_flag_off(prod_app: FastAPI) -> None:
    """
    rithm_dev_endpoints false → the route is not mounted at all.

    This is the prod shape: guarded at include_router() time, so there is no
    handler to reach rather than a handler that declines.
    """
    async with AsyncClient(
        transport=ASGITransport(app=prod_app), base_url="http://test"
    ) as client:
        assert (await client.post(_PATH, json={})).status_code == 404


@pytest.mark.asyncio
async def test_enqueue_writes_row_and_message(
    dev_app: FastAPI,
    sqs_messages: list[dict[str, Any]],
    db_sessions: list[FakeSession],
) -> None:
    async with AsyncClient(
        transport=ASGITransport(app=dev_app), base_url="http://test"
    ) as client:
        response = await client.post(_PATH, json={"kind": "generate"})

    assert response.status_code == 200
    body = response.json()
    job_id = body["job_id"]

    # ── response shape ──
    assert set(body) == {"job_id", "sse_token", "sse_url"}
    assert body["sse_url"] == f"/api/v1/jobs/{job_id}/events?token={body['sse_token']}"

    # ── token is genuinely signed and bound to this job ──
    payload = verify(
        body["sse_token"], get_settings().sse_token_secret.get_secret_value()
    )
    assert payload["jid"] == job_id
    assert payload["uid"] == _SYNTHETIC_USER

    # ── a QUEUED row was inserted ──
    statements = [stmt for session in db_sessions for stmt, _ in session.executed]
    assert any(
        "INSERT INTO generation.jobs" in stmt and "'QUEUED'" in stmt
        for stmt in statements
    )
    params = [p for session in db_sessions for _, p in session.executed][0]
    assert params["id"] == job_id
    assert params["kind"] == "generate"

    # ── the SQS envelope matches §2.1 ──
    assert len(sqs_messages) == 1
    envelope = sqs_messages[0]["body"]
    assert envelope["schema_version"] == 1
    assert envelope["job_id"] == job_id
    assert envelope["user_id"] == _SYNTHETIC_USER
    assert envelope["kind"] == "generate"
    assert envelope["callback_topic_arn"] == (
        get_settings().sns_completions_topic_arn
    )
    assert envelope["audio_reference_url"] is None
    assert envelope["parent_track_id"] is None
    assert "submitted_at" in envelope

    # bpm is a single scalar here — the bpm_min/bpm_max range collapse belongs
    # to the Day-3 public route and must not leak into the envelope.
    assert "bpm" in envelope["params"]
    assert "bpm_min" not in envelope["params"]
    assert envelope["params"]["length_seconds"] == 30

    assert sqs_messages[0]["attributes"] == {
        "job_id": {"DataType": "String", "StringValue": job_id}
    }
    assert sqs_messages[0]["queue_url"] == get_settings().sqs_jobs_queue_url


@pytest.mark.asyncio
async def test_enqueue_honours_supplied_params(
    dev_app: FastAPI,
    sqs_messages: list[dict[str, Any]],
    db_sessions: list[FakeSession],
) -> None:
    async with AsyncClient(
        transport=ASGITransport(app=dev_app), base_url="http://test"
    ) as client:
        response = await client.post(
            _PATH,
            json={
                "kind": "variation",
                "params": {
                    "prompt": "dark synthwave",
                    "genre": "EDM",
                    "bpm": 128,
                    "length_seconds": 60,
                },
            },
        )

    assert response.status_code == 200
    params = sqs_messages[0]["body"]["params"]
    assert params["prompt"] == "dark synthwave"
    assert params["genre"] == "EDM"
    assert params["bpm"] == 128
    assert params["length_seconds"] == 60
    assert sqs_messages[0]["body"]["kind"] == "variation"


@pytest.mark.asyncio
async def test_invalid_kind_is_422(dev_app: FastAPI) -> None:
    async with AsyncClient(
        transport=ASGITransport(app=dev_app), base_url="http://test"
    ) as client:
        response = await client.post(_PATH, json={"kind": "not-a-kind"})
    assert response.status_code == 422
