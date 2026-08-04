from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


def setup_cors(app: FastAPI) -> None:
    from app.config import get_settings

    settings = get_settings()

    # Origins come from the environment, not from a branch on `environment`.
    # Production is SAME-ORIGIN through CloudFront and needs no entry at all;
    # this list exists so the Vite dev server can call a deployed API. See
    # Settings.cors_allowed_origins for why there is no wildcard.
    origins = [
        origin.strip()
        for origin in settings.cors_allowed_origins.split(",")
        if origin.strip()
    ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-Id"],
        # A browser cannot read ANY non-simple response header unless it is
        # listed here. Miss one and the symptom is "works in curl, undefined in
        # the browser" — an hour lost on Day 4 to pagination that looks fine.
        # X-Next-Cursor rides alongside Link because parsing RFC 8288 in a
        # TanStack Query hook is not a good use of Day 4.
        expose_headers=[
            "X-Request-Id",
            "X-Total-Count",
            "X-Next-Cursor",
            "Link",
            "Retry-After",
        ],
    )
