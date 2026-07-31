from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import structlog
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

logger = structlog.get_logger()

_engines: dict[str, AsyncEngine] = {}
_session_factories: dict[str, async_sessionmaker[AsyncSession]] = {}

# Maps module name → lambda that extracts the DSN from Settings
_MODULE_DSN_GETTERS: dict[str, str] = {
    "identity": "db_identity_dsn",
    "catalog": "db_catalog_dsn",
    "generation": "db_generation_dsn",
    "conversation": "db_conversation_dsn",
    "personalization": "db_personalization_dsn",
}

# Public view of the module list — /health/deep pings one session per module.
MODULE_NAMES: tuple[str, ...] = tuple(_MODULE_DSN_GETTERS)


def init_db_engines() -> None:
    """
    Call once from FastAPI lifespan (startup).
    Creates one AsyncEngine + sessionmaker per module.
    """
    from app.config import get_settings
    settings = get_settings()

    for module, dsn_field in _MODULE_DSN_GETTERS.items():
        dsn = getattr(settings, dsn_field).get_secret_value()

        connect_args: dict = {}
        if settings.db_require_ssl:
            connect_args["ssl"] = "require"

        engine = create_async_engine(
            dsn,
            pool_size=5,
            max_overflow=5,
            pool_pre_ping=True,
            connect_args=connect_args,
        )
        _engines[module] = engine
        _session_factories[module] = async_sessionmaker(
            engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )
        logger.info("db_engine_created", module=module)


async def close_db_engines() -> None:
    """Call from FastAPI lifespan (shutdown)."""
    for module, engine in _engines.items():
        await engine.dispose()
        logger.info("db_engine_disposed", module=module)


async def get_identity_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency: identity-module session (auto-commit on success)."""
    async with get_session("identity") as session:
        yield session


async def get_generation_db() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency: generation-module session (auto-commit on success).

    NOT for the SSE stream route — a request-scoped session is torn down only
    after the response completes, so a 5-minute stream would pin a pooled
    connection (pool_size=5 + max_overflow=5 → 10 concurrent streams, then
    everything blocks). generation/service.py opens its own short sessions.
    """
    async with get_session("generation") as session:
        yield session


@asynccontextmanager
async def get_session(module: str) -> AsyncGenerator[AsyncSession, None]:
    """
    Async context manager that yields a module-scoped DB session.

    Usage (inside a service function):
        async with get_session("identity") as session:
            result = await session.execute(select(User).where(...))

    Automatically commits on success, rolls back on exception.
    """
    if module not in _session_factories:
        raise RuntimeError(
            f"DB engine for module '{module}' not initialized. "
            "Was init_db_engines() called at startup?"
        )
    factory = _session_factories[module]
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
