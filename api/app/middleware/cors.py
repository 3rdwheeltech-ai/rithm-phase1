from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


def setup_cors(app: FastAPI) -> None:
    from app.config import get_settings
    settings = get_settings()

    # In prod, restrict to the CloudFront domain only.
    # In local/test, allow localhost origins.
    if settings.environment == "prod":
        origins = [f"https://{settings.cloudfront_distribution_domain}"]
    else:
        origins = [
            "http://localhost:5173",  # vite dev server
            "http://localhost:3000",
        ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-Id"],
        expose_headers=["X-Request-Id", "X-Total-Count", "Link", "Retry-After"],
    )
