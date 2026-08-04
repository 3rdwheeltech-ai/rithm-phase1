"""
The settings that Day 4 made real, and the CORS wiring that reads one of them.

Both are the kind of thing that fails silently: a TTL that ignores its env var
produces a spinner nobody can reproduce locally, and a CORS list that ignores
its env var produces "works in curl, blocked in the browser".
"""

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings, get_settings


def _cors_options(app: FastAPI) -> dict[str, Any]:
    """The kwargs CORSMiddleware was actually constructed with."""
    for middleware in app.user_middleware:
        if middleware.cls is CORSMiddleware:
            return dict(middleware.kwargs)
    raise AssertionError("CORSMiddleware is not installed")


def _build_app() -> FastAPI:
    from app.main import create_app

    return create_app()


def test_documented_defaults() -> None:
    fields = Settings.model_fields
    assert fields["cors_allowed_origins"].default == "http://localhost:5173"
    assert fields["sse_token_ttl_seconds"].default == 1800


def test_cors_origins_come_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:5173, https://example.test ",
    )
    get_settings.cache_clear()
    try:
        options = _cors_options(_build_app())
        assert options["allow_origins"] == [
            "http://localhost:5173",
            "https://example.test",
        ]
    finally:
        monkeypatch.delenv("CORS_ALLOWED_ORIGINS", raising=False)
        get_settings.cache_clear()


def test_cors_no_longer_branches_on_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Day 3 derived the prod origin from cloudfront_distribution_domain. Prod is
    same-origin through CloudFront now and needs no entry at all, so the branch
    is gone — an empty list is the correct prod configuration.
    """
    monkeypatch.setenv("ENVIRONMENT", "prod")
    monkeypatch.setenv("CLOUDFRONT_DISTRIBUTION_DOMAIN", "d123.cloudfront.net")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "")
    get_settings.cache_clear()
    try:
        options = _cors_options(_build_app())
        assert options["allow_origins"] == []
    finally:
        for name in (
            "ENVIRONMENT",
            "CLOUDFRONT_DISTRIBUTION_DOMAIN",
            "CORS_ALLOWED_ORIGINS",
        ):
            monkeypatch.delenv(name, raising=False)
        get_settings.cache_clear()


def test_expose_headers_still_carries_all_four_day_3_headers() -> None:
    """
    A browser cannot read any of these unless they are listed. Miss one and
    pagination reads `undefined` with no error anywhere.
    """
    get_settings.cache_clear()
    try:
        exposed = _cors_options(_build_app())["expose_headers"]
        assert isinstance(exposed, list)
        for header in ("X-Total-Count", "X-Next-Cursor", "Link", "Retry-After"):
            assert header in exposed
    finally:
        get_settings.cache_clear()
