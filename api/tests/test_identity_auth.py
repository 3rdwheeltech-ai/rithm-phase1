"""
Identity module tests that need no Cognito and no live Postgres.

Happy-path signup/login/refresh hit the real dev Cognito pool and are verified
manually (spec Step 14). Here we cover the guard rails: bearer-token rejection
and request validation.
"""
import pytest
from httpx import AsyncClient

from app.main import app
from app.shared.db import get_identity_db


@pytest.fixture
def no_db():
    """Override the DB dependency — these paths must reject before touching the DB."""
    async def _null_db():
        yield None

    app.dependency_overrides[get_identity_db] = _null_db
    yield
    app.dependency_overrides.pop(get_identity_db, None)


@pytest.mark.asyncio
async def test_me_without_token_returns_401(async_client: AsyncClient) -> None:
    response = await async_client.get("/api/v1/me")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_me_with_garbage_token_returns_401(async_client: AsyncClient) -> None:
    response = await async_client.get(
        "/api/v1/me", headers={"Authorization": "Bearer not.a.real.token"}
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_signup_stale_consent_returns_400(
    async_client: AsyncClient, no_db
) -> None:
    response = await async_client.post(
        "/api/v1/auth/signup",
        json={
            "email": "stale@rithm.dev",
            "password": "Test1234",
            "consent_version": "tos-old",
            "name": "Stale Tester",
            "phone_number": "+15555550100",
        },
    )
    assert response.status_code == 400
    # RFC 7807 problem+json: the HTTPException message lands in "title"
    assert "Stale consent version" in response.json()["title"]


@pytest.mark.asyncio
async def test_signup_short_password_returns_422(
    async_client: AsyncClient, no_db
) -> None:
    response = await async_client.post(
        "/api/v1/auth/signup",
        json={
            "email": "short@rithm.dev",
            "password": "short",
            "consent_version": "tos-2026-05",
            "name": "Short Password",
            "phone_number": "+15555550100",
        },
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_signup_invalid_email_returns_422(
    async_client: AsyncClient, no_db
) -> None:
    response = await async_client.post(
        "/api/v1/auth/signup",
        json={
            "email": "not-an-email",
            "password": "Test1234",
            "consent_version": "tos-2026-05",
            "name": "Bad Email",
            "phone_number": "+15555550100",
        },
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_signup_invalid_phone_returns_422(
    async_client: AsyncClient, no_db
) -> None:
    response = await async_client.post(
        "/api/v1/auth/signup",
        json={
            "email": "phone@rithm.dev",
            "password": "Test1234",
            "consent_version": "tos-2026-05",
            "name": "Bad Phone",
            "phone_number": "555-not-e164",
        },
    )
    assert response.status_code == 422
