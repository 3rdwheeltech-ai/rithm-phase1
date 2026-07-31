"""
SNS completion webhook.

The contract under test is spec §0.6: 200 on everything safely handled or
ignored — including an unknown job_id — and 403 only on a failed signature. A
5xx on a valid-but-unactionable message means SNS retry → DLQ → a page about
nothing.

Signature verification itself is monkeypatched here; it is exercised for real
by the cert chain, which needs AWS.
"""
import json
from typing import Any

import pytest
from httpx import AsyncClient

from app.modules.generation import api as generation_api
from app.shared.sns_verify import SNSVerificationError

_PATH = "/internal/sns/job-completion"
_JOB = "01920000-0000-7000-8000-00000000abcd"


@pytest.fixture
def signature_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _pass(_payload: dict[str, Any]) -> None:
        return None

    monkeypatch.setattr(generation_api, "verify_sns_signature", _pass)


@pytest.fixture
def finalize_calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def _record(**kwargs: Any) -> None:
        calls.append(kwargs)

    monkeypatch.setattr(
        generation_api.generation_service, "finalize_job", _record
    )
    return calls


@pytest.mark.asyncio
async def test_bad_signature_is_403(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fail(_payload: dict[str, Any]) -> None:
        raise SNSVerificationError("nope")

    monkeypatch.setattr(generation_api, "verify_sns_signature", _fail)
    response = await async_client.post(_PATH, json={"Type": "Notification"})
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_non_json_body_is_403(async_client: AsyncClient) -> None:
    response = await async_client.post(_PATH, content=b"not json")
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_subscription_confirmation_fetches_subscribe_url(
    async_client: AsyncClient, signature_ok: None, httpx_mock: Any
) -> None:
    subscribe_url = "https://sns.us-east-1.amazonaws.com/?Action=Confirm"
    httpx_mock.add_response(url=subscribe_url, status_code=200)

    response = await async_client.post(
        _PATH,
        json={
            "Type": "SubscriptionConfirmation",
            "SubscribeURL": subscribe_url,
        },
    )
    assert response.status_code == 200
    assert [str(r.url) for r in httpx_mock.get_requests()] == [subscribe_url]


@pytest.mark.asyncio
async def test_notification_success_maps_to_finalize(
    async_client: AsyncClient,
    signature_ok: None,
    finalize_calls: list[dict[str, Any]],
) -> None:
    message = {
        "schema_version": 1,
        "job_id": _JOB,
        "status": "COMPLETED",
        "s3_wav_key": "tracks/u/j/master.wav",
        "s3_mp3_key": "tracks/u/j/audio.mp3",
        "duration_seconds": 30,
        "waveform_hash": "a" * 64,
        "worker_id": "arn:aws:ecs:...",
        "completed_at": "2026-07-27T00:00:00Z",
    }
    response = await async_client.post(
        _PATH, json={"Type": "Notification", "Message": json.dumps(message)}
    )

    assert response.status_code == 200
    assert len(finalize_calls) == 1
    call = finalize_calls[0]
    assert str(call["job_id"]) == _JOB
    assert call["status"] == "COMPLETED"
    assert call["s3_mp3_key"] == "tracks/u/j/audio.mp3"
    assert call["duration_seconds"] == 30


@pytest.mark.asyncio
async def test_notification_failure_maps_to_finalize(
    async_client: AsyncClient,
    signature_ok: None,
    finalize_calls: list[dict[str, Any]],
) -> None:
    message = {
        "schema_version": 1,
        "job_id": _JOB,
        "status": "FAILED",
        "error": "CUDA OOM",
        "error_class": "RuntimeError",
    }
    response = await async_client.post(
        _PATH, json={"Type": "Notification", "Message": json.dumps(message)}
    )

    assert response.status_code == 200
    assert finalize_calls[0]["status"] == "FAILED"
    assert finalize_calls[0]["error"] == "CUDA OOM"


@pytest.mark.asyncio
async def test_unknown_job_id_still_returns_200(
    async_client: AsyncClient,
    signature_ok: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """finalize_job raising must not turn into a 5xx and an SNS retry."""

    async def _raise(**_kwargs: Any) -> None:
        raise RuntimeError("no such job")

    monkeypatch.setattr(
        generation_api.generation_service, "finalize_job", _raise
    )
    message = {"job_id": _JOB, "status": "COMPLETED"}
    response = await async_client.post(
        _PATH, json={"Type": "Notification", "Message": json.dumps(message)}
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_malformed_message_still_returns_200(
    async_client: AsyncClient,
    signature_ok: None,
    finalize_calls: list[dict[str, Any]],
) -> None:
    response = await async_client.post(
        _PATH, json={"Type": "Notification", "Message": "{not json"}
    )
    assert response.status_code == 200
    assert finalize_calls == []


@pytest.mark.asyncio
async def test_unknown_type_returns_200(
    async_client: AsyncClient, signature_ok: None
) -> None:
    response = await async_client.post(
        _PATH, json={"Type": "UnsubscribeConfirmation"}
    )
    assert response.status_code == 200
