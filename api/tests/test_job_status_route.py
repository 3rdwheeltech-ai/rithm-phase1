"""
GET /api/v1/jobs/{job_id} — the polling fallback.

This endpoint exists so a client whose SSE stream died can still learn that its
job finished. Two things are worth pinning beyond the happy path: that a foreign
job is indistinguishable from a missing one (404 both ways, never 403), and that
the catalog join stays inside the two columns rithm_generation is granted —
widen it and the failure is a runtime permission error, which no type checker
will catch for you.
"""
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.modules.generation import service as generation_service_module
from app.shared.auth import require_user
from tests.conftest import FakeSession

USER_ID = UUID("00000000-0000-7000-8000-0000000000f1")
JOB_ID = UUID("00000000-0000-7000-8000-0000000000b1")
TRACK_ID = UUID("00000000-0000-7000-8000-0000000000c1")

CREATED_AT = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)


def _row(
    *,
    status: str,
    track_id: UUID | None = None,
    s3_mp3_key: str | None = None,
    error: str | None = None,
    started_at: datetime | None = None,
    completed_at: datetime | None = None,
) -> dict[str, Any]:
    return {
        "id": JOB_ID,
        "status": status,
        "kind": "generate",
        "created_at": CREATED_AT,
        "started_at": started_at,
        "completed_at": completed_at,
        "error": error,
        "s3_mp3_key": s3_mp3_key,
        "track_id": track_id,
    }


@pytest.fixture
def session_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[dict[str, list[FakeSession] | list[list[Any]]]]:
    """Scripts the single SELECT and records the session it ran on."""
    state: dict[str, Any] = {"opened": [], "rows": []}

    @asynccontextmanager
    async def _session(module: str) -> AsyncIterator[FakeSession]:
        session = FakeSession(results=[list(state["rows"])])
        session.module = module  # type: ignore[attr-defined]
        state["opened"].append(session)
        yield session

    monkeypatch.setattr(generation_service_module, "get_session", _session)
    yield state


@pytest.fixture
def app_with_user(monkeypatch: pytest.MonkeyPatch) -> Iterator[FastAPI]:
    from app.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    monkeypatch.setenv("RITHM_DEV_ENDPOINTS", "0")
    application = create_app()
    application.dependency_overrides[require_user] = lambda: USER_ID
    yield application
    get_settings.cache_clear()


@pytest_asyncio.fixture
async def client(app_with_user: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app_with_user), base_url="http://test"
    ) as http:
        yield http


@pytest.fixture
def presigned(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Captures the keys handed to presign_get, without touching S3."""
    keys: list[str] = []

    def _presign(key: str, expires: int = 900) -> str:
        keys.append(key)
        return f"https://s3.example/{key}?X-Amz-Expires={expires}"

    monkeypatch.setattr(
        "app.modules.generation.api.presign_get", _presign
    )
    return keys


# ── each status ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("status_value", ["QUEUED", "RUNNING", "DEAD_LETTERED"])
async def test_non_terminal_job_carries_neither_track_nor_url(
    client: AsyncClient,
    session_rows: dict[str, Any],
    presigned: list[str],
    status_value: str,
) -> None:
    session_rows["rows"] = [_row(status=status_value)]

    response = await client.get(f"/api/v1/jobs/{JOB_ID}")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == status_value
    assert body["track_id"] is None
    assert body["mp3_url"] is None
    # No presign for a job with nothing to play.
    assert presigned == []


@pytest.mark.asyncio
async def test_completed_job_carries_track_id_and_presigned_mp3(
    client: AsyncClient, session_rows: dict[str, Any], presigned: list[str]
) -> None:
    session_rows["rows"] = [
        _row(
            status="COMPLETED",
            track_id=TRACK_ID,
            s3_mp3_key="tracks/u/j/audio.mp3",
            started_at=CREATED_AT,
            completed_at=CREATED_AT,
        )
    ]

    response = await client.get(f"/api/v1/jobs/{JOB_ID}")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "COMPLETED"
    assert body["track_id"] == str(TRACK_ID)
    assert body["mp3_url"].startswith("https://s3.example/tracks/u/j/audio.mp3")
    assert presigned == ["tracks/u/j/audio.mp3"]


@pytest.mark.asyncio
async def test_failed_job_carries_the_error_and_no_url(
    client: AsyncClient, session_rows: dict[str, Any], presigned: list[str]
) -> None:
    session_rows["rows"] = [
        _row(status="FAILED", error="inference failed", completed_at=CREATED_AT)
    ]

    response = await client.get(f"/api/v1/jobs/{JOB_ID}")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "FAILED"
    assert body["error"] == "inference failed"
    assert body["mp3_url"] is None
    assert presigned == []


@pytest.mark.asyncio
async def test_a_completed_job_without_an_mp3_key_still_answers(
    client: AsyncClient, session_rows: dict[str, Any], presigned: list[str]
) -> None:
    """COMPLETED but no key: presigning None would be a 500 on a poll loop."""
    session_rows["rows"] = [_row(status="COMPLETED", track_id=TRACK_ID)]

    response = await client.get(f"/api/v1/jobs/{JOB_ID}")

    assert response.status_code == 200
    assert response.json()["mp3_url"] is None
    assert presigned == []


# ── ownership ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_job_is_404(
    client: AsyncClient, session_rows: dict[str, Any]
) -> None:
    session_rows["rows"] = []
    response = await client.get(f"/api/v1/jobs/{uuid4()}")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_another_users_job_is_404_not_403(
    client: AsyncClient, session_rows: dict[str, Any]
) -> None:
    """
    The query is user-scoped, so a foreign job returns zero rows and reads as
    missing. A 403 would confirm the id exists — an ownership oracle for nothing.
    """
    session_rows["rows"] = []

    response = await client.get(f"/api/v1/jobs/{JOB_ID}")

    assert response.status_code == 404
    assert response.status_code != 403


# ── the SQL itself ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_query_is_user_scoped_and_runs_on_the_generation_session(
    client: AsyncClient, session_rows: dict[str, Any]
) -> None:
    session_rows["rows"] = [_row(status="QUEUED")]

    await client.get(f"/api/v1/jobs/{JOB_ID}")

    opened: list[FakeSession] = session_rows["opened"]
    assert len(opened) == 1
    assert opened[0].module == "generation"  # type: ignore[attr-defined]

    statement, params = opened[0].executed[0]
    assert params == {"job_id": str(JOB_ID), "user_id": str(USER_ID)}
    assert "j.user_id = CAST(:user_id AS uuid)" in statement


@pytest.mark.asyncio
async def test_catalog_join_touches_only_the_two_granted_columns(
    client: AsyncClient, session_rows: dict[str, Any]
) -> None:
    """
    rithm_generation holds column-scoped SELECT on catalog.tracks (id,
    source_job_id) and nothing else. Selecting or filtering on any other column
    fails at runtime with a permission error that reads like a connection
    problem, so pin the projection here.
    """
    session_rows["rows"] = [_row(status="QUEUED")]

    await client.get(f"/api/v1/jobs/{JOB_ID}")

    statement, _ = session_rows["opened"][0].executed[0]
    catalog_clause = statement[statement.index("LEFT JOIN") :]
    assert "t.source_job_id = j.id" in catalog_clause
    for forbidden in ("t.deleted_at", "t.user_id", "t.prompt", "t.params", "t.*"):
        assert forbidden not in statement
    # Only t.id is projected from catalog.
    assert statement.count("t.") == 2
