from collections.abc import AsyncGenerator, Iterator
from typing import Any

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.modules.generation.sse_hub import SSEHub


@pytest.fixture
def sync_client() -> Iterator[TestClient]:
    with TestClient(app) as client:
        yield client


@pytest_asyncio.fixture
async def async_client() -> AsyncGenerator[AsyncClient, None]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


@pytest.fixture
def hub() -> SSEHub:
    """A fresh, empty hub — never the app's shared one."""
    return SSEHub()


def _app_with_dev_endpoints(
    monkeypatch: pytest.MonkeyPatch, enabled: bool
) -> Iterator[FastAPI]:
    """
    Build an app with RITHM_DEV_ENDPOINTS forced on or off.

    Always set the variable explicitly rather than relying on its absence: a
    real process env var outranks the .env file, and api/.env sets the flag for
    local dev. get_settings is lru_cached, so the cache is cleared on both
    sides or the value either won't take or leaks into later tests.
    """
    from app.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    monkeypatch.setenv("RITHM_DEV_ENDPOINTS", "1" if enabled else "0")
    try:
        yield create_app()
    finally:
        monkeypatch.delenv("RITHM_DEV_ENDPOINTS", raising=False)
        get_settings.cache_clear()


@pytest.fixture
def dev_app(monkeypatch: pytest.MonkeyPatch) -> Iterator[FastAPI]:
    """App instance with the dev routes mounted."""
    yield from _app_with_dev_endpoints(monkeypatch, enabled=True)


@pytest.fixture
def prod_app(monkeypatch: pytest.MonkeyPatch) -> Iterator[FastAPI]:
    """App instance with the dev routes NOT mounted — the prod shape."""
    yield from _app_with_dev_endpoints(monkeypatch, enabled=False)


class FakeResult:
    """Stands in for a SQLAlchemy Result."""

    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def first(self) -> Any:
        return self._rows[0] if self._rows else None

    def mappings(self) -> "FakeResult":
        return self


class FakeSession:
    """
    Records executed statements and replays scripted results.

    Enough of AsyncSession's surface for the raw-SQL service; the alternative
    (a real DB) is Gate C's job, not a unit test's.
    """

    def __init__(self, results: list[list[Any]] | None = None) -> None:
        self.executed: list[tuple[str, dict[str, Any]]] = []
        self._results = list(results or [])

    async def execute(self, statement: Any, params: Any = None) -> FakeResult:
        self.executed.append((str(statement), params or {}))
        if self._results:
            return FakeResult(self._results.pop(0))
        return FakeResult([])

    async def commit(self) -> None:
        return None

    async def rollback(self) -> None:
        return None

    async def flush(self) -> None:
        return None
