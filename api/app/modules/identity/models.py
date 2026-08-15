"""
Schema contract for `identity.users` — specifically its `profile` JSONB column.

Deliberately NOT a SQLAlchemy ORM model, for the same reasons recorded in
catalog/models.py: this codebase has no declarative Base, persistence is raw
`text()` SQL, and migrations/identity/env.py sets `target_metadata = None`
because migrations are hand-written DDL.

The column exists already (migrations/identity/versions/0002_identity_user_profile.py).
Nothing here migrates it.

WHAT POSTGRES GUARANTEES ABOUT `profile` IS ONLY THAT IT IS VALID JSON. The
document shape is owned here, and every read goes through `normalize_profile`
rather than straight into a Pydantic model — see its docstring for why.
"""

import json
from dataclasses import dataclass
from typing import Any, Literal, cast, get_args

from sqlalchemy import RowMapping

USERS_TABLE = "identity.users"

# Bumped only when an existing key CHANGES MEANING, never when one is added —
# adding a key is a new field on the schema + a new default in _EMPTY_PREFERENCES,
# which old documents pick up through normalize_profile for free. When it does
# bump, the upcast belongs in normalize_profile.
PROFILE_VERSION = 1

# ── Vocabularies ──────────────────────────────────────────────────────────
# Genre/Mood are duplicated from catalog/models.py rather than imported: the
# import-linter "Module independence" contract (pyproject.toml) forbids identity
# importing catalog. This is the same trade generation/schemas.py already makes,
# and it is handled the same way — tests/test_identity_profile.py pins this copy
# against catalog's. Tests sit outside the `app` root package, so a test may
# import both trees; application code may not.
#
# Follow-up worth doing on its own, not smuggled into this feature: hoist the
# vocabulary into app/shared/ (shared is not in the contract) and have all three
# modules read it. That means editing generation's StrEnum, which is a public
# wire DTO, so it is a change with its own blast radius.
Genre = Literal[
    "Pop",
    "Hip-Hop",
    "EDM",
    "Lo-Fi",
    "Cinematic",
    "Rock",
    "Country",
    "R&B",
    "Ambient",
]
Mood = Literal[
    "Happy",
    "Calm",
    "Energetic",
    "Dark",
    "Romantic",
    "Inspirational",
    "Dramatic",
]

# Onboarding-only vocabularies. No catalog counterpart — these describe the
# user, not a track.
ExperienceLevel = Literal["beginner", "hobbyist", "pro", "artist"]
PrimaryIntent = Literal[
    "content",  # content & social
    "songwriting",  # songwriting & demos
    "scoring",  # film, games & scoring
    "client",  # client / commercial work
    "exploring",  # just exploring
]
TypicalLength = Literal["short", "standard", "long"]

# Runtime tuples for the vocabulary pin tests and for validation inside
# normalize_profile. `get_args` returns tuple[Any, ...]; the annotations narrow
# it, which is what keeps pyright strict happy at the use sites.
GENRES: tuple[Genre, ...] = get_args(Genre)
MOODS: tuple[Mood, ...] = get_args(Mood)
EXPERIENCE_LEVELS: tuple[ExperienceLevel, ...] = get_args(ExperienceLevel)
PRIMARY_INTENTS: tuple[PrimaryIntent, ...] = get_args(PrimaryIntent)
TYPICAL_LENGTHS: tuple[TypicalLength, ...] = get_args(TypicalLength)

# Caps. The item type is already a Literal, so the only abuse left is length and
# duplicates — both are handled in schemas.py.
MAX_GENRES = 5
MAX_MOODS = 5
# Matches SignupRequest.name, which is where a display name first comes from.
DISPLAY_NAME_MAX = 128

# Column list shared by the SELECTs in service.py and api.py.
ME_COLUMNS = "email, is_admin, profile"


@dataclass(frozen=True, slots=True)
class MeRow:
    """The `/me` projection of identity.users, typed."""

    email: str
    is_admin: bool
    profile: dict[str, Any]

    @classmethod
    def from_row(cls, row: RowMapping) -> "MeRow":
        return cls(
            email=row["email"],
            is_admin=row["is_admin"],
            profile=decode_profile(row["profile"]),
        )


def _as_dict(value: object) -> dict[str, Any]:
    """A JSON object as a str-keyed dict; `{}` for anything else."""
    if not isinstance(value, dict):
        return {}
    # A decoded JSON object is always str-keyed, but the column is untyped, so
    # the cast is what tells pyright that rather than an ignore comment.
    return {str(key): item for key, item in cast(dict[Any, Any], value).items()}


def decode_profile(value: object) -> dict[str, Any]:
    """
    The profile as a dict, whichever way the driver hands it over.

    Mirrors catalog/service.py's _decode_params: asyncpg's JSONB codec normally
    decodes this already, but accepting a str keeps the function honest against
    a codec change and against test doubles.
    """
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return {}
    return _as_dict(value)


def _empty_preferences() -> dict[str, Any]:
    """
    The unset form of every preference.

    Scalars are null and lists are empty — NOT absent. "Skipped onboarding" and
    "answered everything" therefore produce documents of the same shape, which
    is what lets Settings render the same controls for both without a single
    `?.` chain. The two states are distinguishable only by `onboarding.skipped`.
    """
    return {
        "experience_level": None,
        "genres": [],
        "moods": [],
        "primary_intent": None,
        "typical_length": None,
    }


def _coerce_choice(value: object, allowed: tuple[str, ...]) -> str | None:
    return value if isinstance(value, str) and value in allowed else None


def _coerce_choices(value: object, allowed: tuple[str, ...], cap: int) -> list[str]:
    """Keep only known members, de-duplicated, in order, up to `cap`."""
    if not isinstance(value, list):
        return []
    seen: list[str] = []
    for item in cast(list[Any], value):
        if isinstance(item, str) and item in allowed and item not in seen:
            seen.append(item)
        if len(seen) == cap:
            break
    return seen


def normalize_profile(raw: dict[str, Any]) -> dict[str, Any]:
    """
    Turn whatever is in the column into a complete, current-version document.

    Tolerant field by field, on purpose. `Profile.model_validate(raw)` would be
    shorter and is the wrong call: `GET /me` is now on the first-paint path of
    every authenticated route, so one hand-edited row or one document written by
    a future version would 500 that user out of the entire app. A garbage field
    degrades to its empty value instead.

    Unknown keys are PRESERVED, both at the top level and inside `preferences`.
    During a rolling deploy an old task must not wipe a key a new task just
    wrote.
    """
    profile = dict(raw)
    profile["version"] = PROFILE_VERSION

    name = profile.get("display_name")
    profile["display_name"] = (
        name.strip()[:DISPLAY_NAME_MAX] if isinstance(name, str) else ""
    )

    onboarding = _as_dict(profile.get("onboarding"))
    completed = onboarding.get("completed_at")
    onboarding["completed_at"] = completed if isinstance(completed, str) else None
    onboarding["skipped"] = bool(onboarding.get("skipped", False))
    profile["onboarding"] = onboarding

    prefs = {**_empty_preferences(), **_as_dict(profile.get("preferences"))}
    prefs["experience_level"] = _coerce_choice(
        prefs["experience_level"], EXPERIENCE_LEVELS
    )
    prefs["primary_intent"] = _coerce_choice(prefs["primary_intent"], PRIMARY_INTENTS)
    prefs["typical_length"] = _coerce_choice(prefs["typical_length"], TYPICAL_LENGTHS)
    prefs["genres"] = _coerce_choices(prefs["genres"], GENRES, MAX_GENRES)
    prefs["moods"] = _coerce_choices(prefs["moods"], MOODS, MAX_MOODS)
    profile["preferences"] = prefs

    return profile


def initial_profile(display_name: str) -> dict[str, Any]:
    """
    The document written at signup — the one moment the API knows the user's name.

    Everywhere else a row can appear (shared/auth.py's lazy insert) the column
    default `'{}'` applies and normalize_profile fills it in on read.
    """
    return normalize_profile({"display_name": display_name})
