from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # ── Startup ────────────────────────────────────────────────
    from app.config import API_VERSION, get_settings
    from app.shared.db import init_db_engines
    from app.shared.logging import configure_logging

    settings = get_settings()
    configure_logging(settings.log_level)
    init_db_engines()

    logger.info(
        "startup_complete",
        environment=settings.environment,
        version=API_VERSION,
    )
    yield

    # ── Shutdown ───────────────────────────────────────────────
    from app.shared.db import close_db_engines
    await close_db_engines()
    logger.info("shutdown_complete")


def create_app() -> FastAPI:
    from app.config import API_VERSION, get_settings
    from app.middleware.cors import setup_cors
    from app.middleware.error_handler import register_error_handlers
    from app.middleware.request_id import RequestIdMiddleware
    from app.modules.generation.sse_hub import SSEHub

    settings = get_settings()

    app = FastAPI(
        title="RITHM API",
        version=API_VERSION,
        # Disable /docs in prod — the OpenAPI spec is for internal use only
        docs_url="/docs" if settings.environment != "prod" else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.environment != "prod" else None,
        lifespan=lifespan,
    )

    setup_cors(app)
    app.add_middleware(RequestIdMiddleware)
    register_error_handlers(app)

    # ── In-process SSE pub/sub ─────────────────────────────────
    # Created here, NOT in lifespan: `app = create_app()` runs at import, so
    # app.state.sse_hub exists for test clients that never start lifespan.
    # Exactly one hub per process — see sse_hub.py for why that constrains
    # uvicorn to a single process and ECS to desiredCount=1.
    app.state.sse_hub = SSEHub()

    # ── Routers — added as modules are implemented (Days 6–33) ─
    from app.modules.generation import api as generation_api
    from app.modules.identity.api import router as identity_router
    from app.shared import health

    app.include_router(health.router)                    # /health, /health/deep
    app.include_router(identity_router, prefix="/api/v1")
    app.include_router(generation_api.router, prefix="/api/v1")
    # Root-mounted: the SNS subscription URL hardcodes this exact path.
    app.include_router(generation_api.internal_router)

    if settings.rithm_dev_endpoints:
        # Guarded at REGISTRATION, not inside the handler — an unmounted route
        # cannot be reached by a code path you did not expect.
        app.include_router(generation_api.dev_router)
        logger.warning("dev_endpoints_enabled")

    return app


app = create_app()
