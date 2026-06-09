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
