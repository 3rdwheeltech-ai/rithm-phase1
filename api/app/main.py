import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

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
        and settings.sse_token_secret.get_secret_value() == _DEFAULT_SSE_SECRET
    ):
        raise RuntimeError(
            "SSE_TOKEN_SECRET is the public default in prod — refusing to start"
        )

    # THE SAME GUARD AS BEFORE, TURNED AROUND — and it is worth reading why
    # rather than assuming it was weakened.
    #
    # It used to refuse ANY value other than CUSTOMER_CLIENT_V1, because the
    # backend supplied every reply and Anam's own model answering instead was a
    # silent failure. That is no longer the design: Anam's LLM now conducts the
    # conversation, for the latency reasons config.py records.
    #
    # So the failure worth catching has INVERTED. CUSTOMER_CLIENT_V1 means
    # "Anam's brain is off" — and the client no longer supplies replies either,
    # because VoiceTurnLoop was reduced to a recorder. Both brains off is an
    # avatar that connects, renders, listens, and never says anything. An old
    # task-definition revision carrying the previous value is the exact way
    # someone gets there, and it would look like a broken avatar rather than a
    # misconfiguration.
    #
    # Same trade the SSE-secret check above makes: convert an invisible wrong
    # answer into a deployment that never stabilises. `extra="ignore"` on
    # Settings is what makes it necessary — a misspelled env var falls back to
    # the default rather than erroring.
    if settings.anam_enabled and settings.anam_llm_id == settings.anam_disabled_llm_id:
        raise RuntimeError(
            f"ANAM_LLM_ID is {settings.anam_disabled_llm_id}, which turns Anam's "
            "own brain OFF — but this build no longer answers from the backend, "
            "so nothing would speak. The avatar would connect and stay silent. "
            "Refusing to start."
        )

    # An avatar with the wrong voice is worse than no avatar, and there is no
    # sensible default to fall back to — the voice id is an account-specific
    # value recovered from GET /v1/voices. Refuse rather than paper over it.
    if settings.anam_enabled and not settings.anam_voice_id:
        raise RuntimeError(
            "ANAM_ENABLED is set but ANAM_VOICE_ID is empty — refusing to start"
        )

    init_db_engines()

    # ── Stuck-job sweeper ──────────────────────────────────────
    # Started here because this is the only place DB engines exist. It is given
    # THIS app's hub, not a fresh one, so the `failed` frames it publishes reach
    # the clients actually streaming. Disabled in the test fixture — otherwise
    # every test run spawns a background DB task.
    sweeper: asyncio.Task[None] | None = None
    if settings.sweeper_enabled:
        from app.modules.generation.service import generation_service

        sweeper = asyncio.create_task(generation_service.run_sweeper(app.state.sse_hub))
        logger.info(
            "sweeper_started",
            interval_seconds=settings.sweeper_interval_seconds,
        )

    logger.info(
        "startup_complete",
        environment=settings.environment,
        version=API_VERSION,
    )
    yield

    # ── Shutdown ───────────────────────────────────────────────
    if sweeper is not None:
        sweeper.cancel()
        # Awaiting the cancellation is what makes shutdown deterministic; a
        # bare cancel() returns before the task has actually unwound.
        with suppress(asyncio.CancelledError):
            await sweeper

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
    from app.modules.catalog.service import catalog_service
    from app.modules.generation.service import generation_service

    # The module singleton, not a fresh instance — catalog's own router uses the
    # same object, so patching it in a test patches one thing rather than two
    # that happen to behave alike.
    #
    # It serves both directions: catalog writes the track on job completion
    # (TrackWriter) and reads the parent a variation or refine derives from
    # (TrackReader). The reader runs on catalog's OWN connection, which is what
    # keeps rithm_generation's grant as narrow as Day 2 left it.
    generation_service.track_writer = catalog_service
    generation_service.track_reader = catalog_service

    # ── Routers ────────────────────────────────────────────────
    from app.modules.catalog import api as catalog_api
    from app.modules.conversation import api as conversation_api
    from app.modules.generation import api as generation_api
    from app.modules.identity.api import router as identity_router
    from app.shared import health

    app.include_router(health.router)  # /health, /health/deep
    app.include_router(identity_router, prefix="/api/v1")
    # Generation BEFORE catalog: they share the /tracks prefix, generation
    # owning the POST verbs and catalog the GET/DELETE. They cannot collide
    # today (different methods) and every path param on both sides is typed
    # UUID, but registering in this order means a future literal path segment
    # cannot be swallowed by /tracks/{track_id} either.
    app.include_router(generation_api.router, prefix="/api/v1")
    app.include_router(catalog_api.router, prefix="/api/v1")
    # The chat assistant. Its paths are all under /chat, so it collides with
    # nothing above and its position here is only convention.
    app.include_router(conversation_api.router, prefix="/api/v1")
    # Root-mounted: the SNS subscription URL hardcodes this exact path.
    app.include_router(generation_api.internal_router)

    if settings.rithm_dev_endpoints:
        # Guarded at REGISTRATION, not inside the handler — an unmounted route
        # cannot be reached by a code path you did not expect.
        app.include_router(generation_api.dev_router)
        logger.warning("dev_endpoints_enabled")

    return app


app = create_app()
