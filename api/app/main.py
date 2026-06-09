from contextlib import asynccontextmanager
from fastapi import FastAPI
import structlog

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ────────────────────────────────────────────────
    from app.config import get_settings
    from app.shared.logging import configure_logging
    from app.shared.db import init_db_engines

    settings = get_settings()
    configure_logging(settings.log_level)
    init_db_engines()

    logger.info(
        "startup_complete",
        environment=settings.environment,
        version="0.1.0",
    )
    yield

    # ── Shutdown ───────────────────────────────────────────────
    from app.shared.db import close_db_engines
    await close_db_engines()
    logger.info("shutdown_complete")


def create_app() -> FastAPI:
    from app.config import get_settings
    from app.middleware.cors import setup_cors
    from app.middleware.request_id import RequestIdMiddleware
    from app.middleware.error_handler import register_error_handlers

    settings = get_settings()

    app = FastAPI(
        title="RITHM API",
        version="0.1.0",
        # Disable /docs in prod — the OpenAPI spec is for internal use only
        docs_url="/docs" if settings.environment != "prod" else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.environment != "prod" else None,
        lifespan=lifespan,
    )

    setup_cors(app)
    app.add_middleware(RequestIdMiddleware)
    register_error_handlers(app)

    # ── Health (no auth required) ──────────────────────────────
    @app.get("/health", tags=["ops"], include_in_schema=False)
    async def health() -> dict:
        return {"status": "ok", "version": "0.1.0"}

    # ── Routers — added as modules are implemented (Days 6–33) ─
    from app.modules.identity.api import router as identity_router
    app.include_router(identity_router, prefix="/api/v1")
    # ... etc.

    return app


app = create_app()
