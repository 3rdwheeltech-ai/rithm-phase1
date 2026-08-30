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


# ── The Anam boot guards ───────────────────────────────────────────────────


def _boot(app: FastAPI) -> None:
    """Run the app's lifespan, which is where both guards live."""
    from fastapi.testclient import TestClient

    with TestClient(app):
        pass


# Every ANAM_* variable the guards read. Set explicitly in each test rather
# than inherited, because `Settings` has `env_file=".env"` and a developer who
# has switched voice on locally would otherwise see these tests fail on their
# machine and pass in CI — which is the worst way to learn about coupling.
_ANAM_VARS = ("ANAM_ENABLED", "ANAM_VOICE_ID", "ANAM_LLM_ID")


def _anam_env(monkeypatch: pytest.MonkeyPatch, **values: str) -> None:
    """Pin every ANAM_* variable, so `.env` cannot reach into a guard test."""
    for name in _ANAM_VARS:
        monkeypatch.delenv(name, raising=False)
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()


def test_it_refuses_to_start_when_both_brains_are_switched_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    THE OLD GUARD, TURNED AROUND — and the inversion is the point.

    It used to refuse anything that was NOT CUSTOMER_CLIENT_V1, back when the
    backend wrote every reply and Anam answering instead was the silent
    failure. Anam's own model now conducts the conversation, so the failure
    worth catching is the opposite one: CUSTOMER_CLIENT_V1 turns Anam's brain
    off, the client no longer supplies replies either, and the avatar would
    connect, render, listen and never say a word.

    An old task-definition revision carrying the previous value is exactly how
    someone arrives there, and it would read as a broken avatar rather than as
    a misconfiguration. So it is a deployment that never stabilises instead.
    """
    _anam_env(
        monkeypatch,
        ANAM_ENABLED="true",
        ANAM_VOICE_ID="voice-id",
        ANAM_LLM_ID="CUSTOMER_CLIENT_V1",
    )
    try:
        with pytest.raises(RuntimeError, match="CUSTOMER_CLIENT_V1"):
            _boot(_build_app())
    finally:
        _anam_env(monkeypatch)


def test_a_real_anam_brain_boots(monkeypatch: pytest.MonkeyPatch) -> None:
    """The other half of the guard: any real model id is allowed through."""
    _anam_env(
        monkeypatch,
        ANAM_ENABLED="true",
        ANAM_VOICE_ID="voice-id",
        ANAM_LLM_ID="a7cf662c-2ace-4de1-a21e-ef0fbf144bb7",
    )
    try:
        _boot(_build_app())
    finally:
        _anam_env(monkeypatch)


def test_it_refuses_to_start_with_voice_enabled_and_no_voice_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An avatar with the wrong voice is worse than no avatar, and there is no
    sensible default to fall back to."""
    # A real brain id, so the guard under test is the one that fires.
    _anam_env(
        monkeypatch,
        ANAM_ENABLED="true",
        ANAM_VOICE_ID="",
        ANAM_LLM_ID="a7cf662c-2ace-4de1-a21e-ef0fbf144bb7",
    )
    try:
        with pytest.raises(RuntimeError, match="ANAM_VOICE_ID"):
            _boot(_build_app())
    finally:
        _anam_env(monkeypatch)


def test_neither_guard_fires_when_voice_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    The default everywhere. Local, CI and any environment without a key must
    boot exactly as they do today.
    """
    _anam_env(monkeypatch, ANAM_ENABLED="false")
    try:
        _boot(_build_app())
    finally:
        _anam_env(monkeypatch)


def test_the_anam_defaults_are_the_documented_ones() -> None:
    fields = Settings.model_fields
    assert fields["anam_enabled"].default is False
    # Anam's own GPT OSS 120B, attached to the Ria-rithm persona. NOT
    # CUSTOMER_CLIENT_V1 any more — see config.py for what that trade cost.
    assert fields["anam_llm_id"].default == "a7cf662c-2ace-4de1-a21e-ef0fbf144bb7"
    assert fields["anam_disabled_llm_id"].default == "CUSTOMER_CLIENT_V1"
    # No default voice — see the guard above.
    assert fields["anam_voice_id"].default == ""
    # The lease must outlive the session it is advisory about.
    assert fields["anam_lease_slack_seconds"].default > 0
