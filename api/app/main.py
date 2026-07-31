from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI

logger = structlog.get_logger()

# Must match config.Settings.sse_token_secret's default. Kept here so the
# lifespan check reads as a literal comparison against a known-bad value.
_DEFAULT_SSE_SECRET = "dev-sse-secret-change-me"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # ── Startup ────────────────────────────────────────────────
    from app.config import API_VERSION, get_settings
    from app.shared.db import init_db_engines
    from app.shared.logging import configure_logging

    settings = get_settings()
    configure_logging(settings.log_level)

    # Refuse to serve prod traffic with the signing key that is published in
    # this repo. Without this a taskdef that forgets SSE_TOKEN_SECRET boots
    # happily and mints stream tokens anyone can forge — `extra="ignore"` means
    # a misspelled env var falls back to the default rather than erroring.
    if (
        settings.environment == "prod"
        and settings.sse_token_secret.get_secret_value()
        == _DEFAULT_SSE_SECRET
    ):
        raise RuntimeError(
            "SSE_TOKEN_SECRET is the public default in prod — refusing to start"
        )

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

    # ── Composition root: generation → catalog ─────────────────
    # The ONLY place these two modules meet. generation never imports catalog
    # (import-linter forbids it); it declares a TrackWriter Protocol and takes
    # an implementation. CatalogService satisfies that Protocol structurally,
    # and this assignment is where pyright checks that it actually does.
    #
    # Bound here rather than in lifespan for the same reason the hub is: the
    # test suite's ASGITransport never runs lifespan, so anything lifespan-bound
    # is invisible to most of the suite.
    from app.modules.catalog.service import CatalogService
    from app.modules.generation.service import generation_service

    generation_service.track_writer = CatalogService()

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
