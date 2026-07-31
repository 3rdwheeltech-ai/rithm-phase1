from contextlib import asynccontextmanager
from typing import Any

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_returns_200(async_client: AsyncClient) -> None:
    response = await async_client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "version" in body


@pytest.mark.asyncio
async def test_health_has_request_id_header(async_client: AsyncClient) -> None:
    response = await async_client.get("/health")
    assert "x-request-id" in response.headers


@pytest.mark.asyncio
async def test_404_returns_problem_json(async_client: AsyncClient) -> None:
    response = await async_client.get("/nonexistent-path")
    assert response.status_code == 404
    body = response.json()
    assert "type" in body
    assert "title" in body
    assert "status" in body
    assert body["status"] == 404


@pytest.mark.asyncio
async def test_health_does_no_db_io(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    /health is the ALB and container healthcheck target. If it touched the DB,
    an RDS blip would cycle every task — so prove it doesn't, by making any DB
    access explode.
    """

    @asynccontextmanager
    async def exploding_session(_module: str) -> Any:
        raise AssertionError("/health must not touch the database")
        yield  # pragma: no cover

    monkeypatch.setattr(
        "app.shared.health.get_session", exploding_session
    )
    assert (await async_client.get("/health")).status_code == 200


def _fake_session_factory(
    failing: set[str],
) -> Any:
    @asynccontextmanager
    async def _session(module: str) -> Any:
        if module in failing:
            raise RuntimeError(f"{module} unreachable")

        class _Session:
            async def execute(self, *_args: Any, **_kwargs: Any) -> None:
                return None

        yield _Session()

    return _session


@pytest.mark.asyncio
async def test_health_deep_all_ok(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "app.shared.health.get_session", _fake_session_factory(set())
    )
    response = await async_client.get("/health/deep")
    assert response.status_code == 200
    body = response.json()
    assert body["db"] == "ok"
    assert set(body["modules"].values()) == {"ok"}


@pytest.mark.asyncio
async def test_health_deep_reports_503_on_module_failure(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "app.shared.health.get_session",
        _fake_session_factory({"catalog"}),
    )
    response = await async_client.get("/health/deep")
    assert response.status_code == 503
    body = response.json()
    assert body["db"] == "error"
    assert body["modules"]["catalog"] == "error"
    assert body["modules"]["identity"] == "ok"
