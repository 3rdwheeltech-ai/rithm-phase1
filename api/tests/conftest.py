import os
from collections.abc import AsyncGenerator, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Set BEFORE app.main is imported, because get_settings() is lru_cached and the
# import chain populates it. Without this, every fixture that runs lifespan
# (TestClient does) spawns a real background DB task and the suite develops a
# personality — intermittent connection errors from a sweeper ticking against a
# database no test asked for.
os.environ.setdefault("SWEEPER_ENABLED", "false")

from app.main import app  # noqa: E402
from app.modules.generation.sse_hub import SSEHub  # noqa: E402

# ── Live-database opt-in ───────────────────────────────────────
# Most of this suite runs against FakeSession: a real DB proves nothing extra
# about SQL the service builds from constants. The exceptions are the
# cross-schema transaction and the grant it depends on — those only exist in
# Postgres, so test_catalog_live.py opts in through these variables and skips
# cleanly when they are unset (which is what keeps `uv run pytest` green with no
# containers running).
#
# TWO DSNs, and the split is the point:
#
#   RITHM_TEST_DB_DSN        the *generation* role. Everything under test runs
#                            as this, so a missing
#                            0002_catalog_generation_grants fails here rather
#                            than in prod.
#   RITHM_TEST_DB_ADMIN_DSN  an owner/admin role, used ONLY for fixture setup,
#                            verification reads and teardown. Necessary because
#                            the grant is deliberately INSERT-only: the
#                            generation role can write catalog.tracks and
#                            cannot read or delete it. Needing this second
#                            connection is itself evidence the grant is as
#                            narrow as intended.
#
# Setup, against the compose Postgres (host port 5433, database rithm-db):
#
#   docker compose up -d postgres
#   BASE=localhost:5433/rithm-db
#   ADMIN=postgresql+asyncpg://rithm_admin:dev_admin_pw_change_me@$BASE
#   GEN=postgresql+asyncpg://rithm_generation:dev_generation_pw@$BASE
#
#   DB_CATALOG_DSN=$ADMIN \
#       uv run alembic -c migrations/catalog/alembic.ini upgrade head
#   RITHM_TEST_DB_DSN=$GEN RITHM_TEST_DB_ADMIN_DSN=$ADMIN \
#       uv run pytest tests/test_catalog_live.py
LIVE_DB_DSN = os.getenv("RITHM_TEST_DB_DSN")
LIVE_DB_ADMIN_DSN = os.getenv("RITHM_TEST_DB_ADMIN_DSN")

requires_live_db = pytest.mark.skipif(
    not (LIVE_DB_DSN and LIVE_DB_ADMIN_DSN),
    reason=(
        "RITHM_TEST_DB_DSN / RITHM_TEST_DB_ADMIN_DSN unset — "
        "see tests/conftest.py for the live-DB setup"
    ),
)


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


@asynccontextmanager
async def _engine_session(dsn: str) -> AsyncGenerator[AsyncSession, None]:
    """
    One committing session on a throwaway engine.

    Not wrapped in a rollback-everything outer transaction: the code under test
    owns its own commit boundary, and stubbing that out would test something
    other than the atomicity we care about. Tests clean up their own rows by id.
    """
    engine = create_async_engine(dsn)
    try:
        factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        async with factory() as session:
            yield session
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def live_session() -> AsyncGenerator[AsyncSession, None]:
    """A session as the *generation* role — the one under test."""
    assert LIVE_DB_DSN is not None      # guarded by requires_live_db
    async with _engine_session(LIVE_DB_DSN) as session:
        yield session


@pytest_asyncio.fixture
async def admin_session() -> AsyncGenerator[AsyncSession, None]:
    """
    A session as an owner role, for setup / verification / teardown only.

    The generation role has INSERT on catalog and nothing else, so reads and
    deletes there must come from here. Never use this for the code under test.
    """
    assert LIVE_DB_ADMIN_DSN is not None
    async with _engine_session(LIVE_DB_ADMIN_DSN) as session:
        yield session


@pytest_asyncio.fixture
async def live_generation_engine() -> AsyncGenerator[None, None]:
    """
    Point app.shared.db's generation engine at the test database.

    finalize_job reaches for get_session("generation"), which resolves through
    the module-level registry that lifespan normally populates — and no test
    client in this suite runs lifespan. Registering the engine here is what lets
    the real service method run end to end against Postgres.
    """
    from app.config import get_settings
    from app.shared.db import close_db_engines, init_db_engines

    assert LIVE_DB_DSN is not None
    previous = os.environ.get("DB_GENERATION_DSN")
    os.environ["DB_GENERATION_DSN"] = LIVE_DB_DSN
    get_settings.cache_clear()
    init_db_engines()   # other modules' engines are created but never connected
    try:
        yield
    finally:
        await close_db_engines()
        if previous is None:
            os.environ.pop("DB_GENERATION_DSN", None)
        else:
            os.environ["DB_GENERATION_DSN"] = previous
        get_settings.cache_clear()


@pytest_asyncio.fixture
async def live_catalog_engine() -> AsyncGenerator[None, None]:
    """
    Point app.shared.db's CATALOG engine at the test database.

    The Day-3 twin of live_generation_engine, and it uses the ADMIN DSN rather
    than the module DSN on purpose: the read methods authenticate as
    rithm_catalog in production, and the compose database's rithm_catalog role
    is what the admin connection stands in for here. What these tests prove is
    that the reads run on catalog's connection AT ALL — the generation role
    would be refused, which is the whole reason TrackReader exists.
    """
    from app.config import get_settings
    from app.shared.db import close_db_engines, init_db_engines

    assert LIVE_DB_ADMIN_DSN is not None
    previous = os.environ.get("DB_CATALOG_DSN")
    os.environ["DB_CATALOG_DSN"] = LIVE_DB_ADMIN_DSN
    get_settings.cache_clear()
    init_db_engines()
    try:
        yield
    finally:
        await close_db_engines()
        if previous is None:
            os.environ.pop("DB_CATALOG_DSN", None)
        else:
            os.environ["DB_CATALOG_DSN"] = previous
        get_settings.cache_clear()


class FakeResult:
    """Stands in for a SQLAlchemy Result."""

    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def first(self) -> Any:
        return self._rows[0] if self._rows else None

    def all(self) -> list[Any]:
        return list(self._rows)

    def scalar_one(self) -> Any:
        """Mirrors SQLAlchemy: first column of the single row."""
        return self._rows[0][0]

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
        # Counted so a collaborator handed this session can be checked for
        # committing someone else's transaction — see test_catalog_service.
        self.commits = 0
        self.rollbacks = 0

    async def execute(self, statement: Any, params: Any = None) -> FakeResult:
        self.executed.append((str(statement), params or {}))
        if self._results:
            return FakeResult(self._results.pop(0))
        return FakeResult([])

    async def commit(self) -> None:
        self.commits += 1

    async def rollback(self) -> None:
        self.rollbacks += 1

    async def flush(self) -> None:
        return None
