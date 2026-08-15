"""
The profile document: validation, normalization, merge, and the SQL it emits.

Route coverage here is the guard rails only — the same split as
test_identity_auth.py. Everything below the route is a pure function or a
FakeSession assertion, because the interesting behaviour (an absent key vs an
explicit null, a garbage column, a no-op save) is exactly what a live-DB test
would make hardest to see.
"""

import json
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from app.main import app
from app.modules.identity.models import (
    DISPLAY_NAME_MAX,
    EXPERIENCE_LEVELS,
    MAX_GENRES,
    PRIMARY_INTENTS,
    PROFILE_VERSION,
    TYPICAL_LENGTHS,
    decode_profile,
    initial_profile,
    normalize_profile,
)
from app.modules.identity.schemas import ProfilePatchRequest
from app.modules.identity.service import identity_service, merge_profile
from app.shared.db import get_identity_db

from .conftest import FakeSession

_NOW = datetime(2026, 8, 15, 10, 4, 11, tzinfo=UTC)
_USER_ID = "01920000-0000-7000-8000-000000000001"


def _patch(**body: Any) -> ProfilePatchRequest:
    """Build a patch the way the route does — through validation, not the ctor.

    `ProfilePatchRequest(**body)` would mark every field as "set", which is the
    one thing these tests are trying to distinguish.
    """
    return ProfilePatchRequest.model_validate(body)


@pytest.fixture
def no_db() -> Iterator[None]:
    """Override the DB dependency — these paths must reject before touching it."""

    async def _null_db() -> AsyncIterator[None]:
        yield None

    app.dependency_overrides[get_identity_db] = _null_db
    yield
    app.dependency_overrides.pop(get_identity_db, None)


# ── Route guards ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_patch_profile_without_token_returns_401(
    async_client: AsyncClient, no_db: None
) -> None:
    response = await async_client.patch("/api/v1/me/profile", json={})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_patch_profile_with_garbage_token_returns_401(
    async_client: AsyncClient, no_db: None
) -> None:
    response = await async_client.patch(
        "/api/v1/me/profile",
        json={},
        headers={"Authorization": "Bearer not.a.real.token"},
    )
    assert response.status_code == 401


# ── Request validation ────────────────────────────────────────────────────
# Asserted against the model rather than the route: require_user resolves
# before the body is validated, so a route-level test would prove nothing about
# the schema without also standing up a JWT.


def test_patch_rejects_unknown_top_level_key() -> None:
    with pytest.raises(ValidationError):
        _patch(favourite_colour="teal")


def test_patch_rejects_unknown_preference_key() -> None:
    with pytest.raises(ValidationError):
        _patch(preferences={"tempo": "fast"})


def test_patch_rejects_genre_outside_the_vocabulary() -> None:
    with pytest.raises(ValidationError):
        _patch(preferences={"genres": ["Polka"]})


def test_patch_rejects_more_genres_than_the_cap() -> None:
    with pytest.raises(ValidationError):
        _patch(
            preferences={
                "genres": ["Pop", "Hip-Hop", "EDM", "Lo-Fi", "Cinematic", "Rock"]
            }
        )


def test_patch_rejects_unknown_experience_level() -> None:
    with pytest.raises(ValidationError):
        _patch(preferences={"experience_level": "wizard"})


def test_patch_rejects_unknown_onboarding_action() -> None:
    with pytest.raises(ValidationError):
        _patch(onboarding_action="finished")


def test_patch_rejects_an_overlong_display_name() -> None:
    with pytest.raises(ValidationError):
        _patch(display_name="x" * (DISPLAY_NAME_MAX + 1))


def test_patch_dedupes_genres_so_duplicates_cannot_spend_the_cap() -> None:
    patch = _patch(preferences={"genres": ["Pop", "Pop", "EDM"]})
    assert patch.preferences is not None
    assert patch.preferences.genres == ["Pop", "EDM"]


# ── Normalization ─────────────────────────────────────────────────────────


def test_normalize_empty_document_yields_every_key() -> None:
    profile = normalize_profile({})

    assert profile["version"] == PROFILE_VERSION
    assert profile["display_name"] == ""
    assert profile["onboarding"] == {"completed_at": None, "skipped": False}
    assert profile["preferences"] == {
        "experience_level": None,
        "genres": [],
        "moods": [],
        "primary_intent": None,
        "typical_length": None,
    }


def test_normalize_tolerates_garbage_rather_than_raising() -> None:
    """A hand-edited row must not 500 GET /me — it is on every page's first paint."""
    profile = normalize_profile(
        {
            "display_name": 42,
            "onboarding": "nope",
            "preferences": {"genres": "Pop", "experience_level": "wizard"},
        }
    )

    assert profile["display_name"] == ""
    assert profile["onboarding"]["completed_at"] is None
    assert profile["preferences"]["genres"] == []
    assert profile["preferences"]["experience_level"] is None


def test_normalize_drops_unknown_vocabulary_members_but_keeps_the_rest() -> None:
    profile = normalize_profile({"preferences": {"genres": ["Pop", "Polka", "EDM"]}})
    assert profile["preferences"]["genres"] == ["Pop", "EDM"]


def test_normalize_caps_an_overlong_stored_list() -> None:
    stored = ["Pop", "Hip-Hop", "EDM", "Lo-Fi", "Cinematic", "Rock", "Country"]
    profile = normalize_profile({"preferences": {"genres": stored}})
    assert len(profile["preferences"]["genres"]) == MAX_GENRES


def test_normalize_preserves_unknown_keys() -> None:
    """A rolling deploy means an old task must not wipe a new task's key."""
    profile = normalize_profile(
        {"future_key": "keep me", "preferences": {"future_pref": "keep me too"}}
    )
    assert profile["future_key"] == "keep me"
    assert profile["preferences"]["future_pref"] == "keep me too"


def test_decode_profile_accepts_a_json_string() -> None:
    """asyncpg's codec normally decodes JSONB; this keeps us honest if it stops."""
    assert decode_profile('{"display_name": "Ada"}') == {"display_name": "Ada"}


def test_decode_profile_falls_back_to_empty_on_junk() -> None:
    assert decode_profile("not json at all") == {}
    assert decode_profile(None) == {}


def test_initial_profile_seeds_the_display_name() -> None:
    profile = initial_profile("Ada Lovelace")
    assert profile["display_name"] == "Ada Lovelace"
    assert profile["onboarding"]["completed_at"] is None


# ── Merge ─────────────────────────────────────────────────────────────────


def test_merge_leaves_keys_the_patch_did_not_set() -> None:
    current = normalize_profile(
        {"display_name": "Ada", "preferences": {"moods": ["Calm"], "genres": ["Pop"]}}
    )

    merged = merge_profile(current, _patch(preferences={"genres": ["EDM"]}), now=_NOW)

    assert merged["preferences"]["genres"] == ["EDM"]
    assert merged["preferences"]["moods"] == ["Calm"]  # untouched
    assert merged["display_name"] == "Ada"  # untouched


def test_merge_explicit_null_clears_but_an_absent_key_does_not() -> None:
    current = normalize_profile(
        {"preferences": {"experience_level": "pro", "primary_intent": "content"}}
    )

    # Explicit null in the JSON body -> cleared.
    cleared = merge_profile(
        current,
        ProfilePatchRequest.model_validate_json(
            '{"preferences": {"experience_level": null}}'
        ),
        now=_NOW,
    )
    assert cleared["preferences"]["experience_level"] is None
    # ...and the sibling the body never mentioned survives.
    assert cleared["preferences"]["primary_intent"] == "content"


def test_merge_empty_patch_is_a_no_op() -> None:
    current = normalize_profile({"display_name": "Ada"})
    assert merge_profile(current, _patch(), now=_NOW) == current


def test_skip_completes_onboarding_and_leaves_preferences_empty() -> None:
    merged = merge_profile(
        normalize_profile({}), _patch(onboarding_action="skip"), now=_NOW
    )

    assert merged["onboarding"]["skipped"] is True
    assert merged["onboarding"]["completed_at"] == "2026-08-15T10:04:11Z"
    # The requirement: the keys are PRESENT and empty, not absent.
    assert merged["preferences"] == normalize_profile({})["preferences"]


def test_complete_stamps_the_server_clock_not_a_client_value() -> None:
    merged = merge_profile(
        normalize_profile({}), _patch(onboarding_action="complete"), now=_NOW
    )
    assert merged["onboarding"] == {
        "completed_at": "2026-08-15T10:04:11Z",
        "skipped": False,
    }


def test_completed_at_is_not_restamped_on_a_later_patch() -> None:
    first = merge_profile(
        normalize_profile({}), _patch(onboarding_action="complete"), now=_NOW
    )
    later = datetime(2027, 1, 1, tzinfo=UTC)

    second = merge_profile(first, _patch(onboarding_action="complete"), now=later)

    assert second["onboarding"]["completed_at"] == first["onboarding"]["completed_at"]


# ── Service / SQL ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_patch_profile_locks_the_row_before_writing() -> None:
    session = FakeSession([[("{}",)]])

    await identity_service.patch_profile(
        session,  # type: ignore[arg-type]
        _USER_ID,  # type: ignore[arg-type]
        _patch(display_name="Ada"),
    )

    assert "FOR UPDATE" in session.executed[0][0]


@pytest.mark.asyncio
async def test_patch_profile_binds_the_document_as_a_json_string() -> None:
    """
    The regression guard for the asyncpg bind.

    With text() there is no column type for SQLAlchemy to hang its JSONB codec
    on, so a bare dict reaches the driver as an unencodable object. It must be
    json.dumps'd and CAST in the SQL.
    """
    session = FakeSession([[("{}",)]])

    await identity_service.patch_profile(
        session,  # type: ignore[arg-type]
        _USER_ID,  # type: ignore[arg-type]
        _patch(display_name="Ada"),
    )

    statement, params = session.executed[1]
    assert "CAST(:profile AS JSONB)" in statement
    assert isinstance(params["profile"], str)
    assert json.loads(params["profile"])["display_name"] == "Ada"


@pytest.mark.asyncio
async def test_patch_profile_skips_the_write_when_nothing_changed() -> None:
    """users_touch fires on any UPDATE — a no-op Save must not move updated_at."""
    stored = json.dumps(normalize_profile({"display_name": "Ada"}))
    session = FakeSession([[(stored,)]])

    await identity_service.patch_profile(
        session,  # type: ignore[arg-type]
        _USER_ID,  # type: ignore[arg-type]
        _patch(display_name="Ada"),
    )

    assert len(session.executed) == 1  # the SELECT only


@pytest.mark.asyncio
async def test_patch_profile_returns_none_for_a_missing_row() -> None:
    session = FakeSession([[]])

    result = await identity_service.patch_profile(
        session,  # type: ignore[arg-type]
        _USER_ID,  # type: ignore[arg-type]
        _patch(display_name="Ada"),
    )

    assert result is None


# ── Vocabulary pins ───────────────────────────────────────────────────────


def test_profile_vocabulary_matches_the_catalog_vocabulary() -> None:
    """
    identity re-declares GENRES/MOODS because import-linter forbids it importing
    catalog. Tests sit outside the `app` root package, so they may import both —
    which is the only thing keeping the two copies from drifting. Mirrors
    test_generation_routes.py's pin on generation's copy.
    """
    from app.modules.catalog.models import GENRES as CATALOG_GENRES
    from app.modules.catalog.models import MOODS as CATALOG_MOODS
    from app.modules.identity.models import GENRES, MOODS

    assert GENRES == CATALOG_GENRES
    assert MOODS == CATALOG_MOODS


def test_onboarding_vocabularies_match_the_ui_copy() -> None:
    """Pinned literally, the same way web/src/types/api.test.ts pins its copy."""
    assert EXPERIENCE_LEVELS == ("beginner", "hobbyist", "pro", "artist")
    assert PRIMARY_INTENTS == (
        "content",
        "songwriting",
        "scoring",
        "client",
        "exploring",
    )
    assert TYPICAL_LENGTHS == ("short", "standard", "long")
