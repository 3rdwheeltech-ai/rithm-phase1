from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, EmailStr, Field

from app.modules.identity.models import (
    DISPLAY_NAME_MAX,
    MAX_GENRES,
    MAX_MOODS,
    PROFILE_VERSION,
    ExperienceLevel,
    Genre,
    Mood,
    PrimaryIntent,
    TypicalLength,
)


class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    consent_version: str
    # Required attributes on the dev user pool (immutable pool config).
    # given_name is derived from name server-side.
    name: str = Field(min_length=1, max_length=DISPLAY_NAME_MAX)
    phone_number: str = Field(pattern=r"^\+[1-9]\d{1,14}$")  # E.164


class SignupResponse(BaseModel):
    user_id: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    # email is required to compute the Cognito SECRET_HASH for REFRESH_TOKEN_AUTH
    # (the app client has a secret) — see specDeviations.md.
    email: EmailStr
    refresh_token: str


class TokenResponse(BaseModel):
    id_token: str
    refresh_token: str | None = None
    expires_in: int
    token_type: str


# ── Profile: response side ────────────────────────────────────────────────
# These mirror the document normalize_profile() produces. Every field has a
# default so the models stay constructible from a partial dict, but in practice
# they are only ever built from an already-normalized document.


class OnboardingState(BaseModel):
    completed_at: datetime | None = None
    skipped: bool = False


class Preferences(BaseModel):
    experience_level: ExperienceLevel | None = None
    # A literal mutable default is safe in Pydantic — it deep-copies per
    # instance — and keeps the element type visible, which `default_factory=list`
    # does not.
    genres: list[Genre] = []
    moods: list[Mood] = []
    primary_intent: PrimaryIntent | None = None
    typical_length: TypicalLength | None = None


class Profile(BaseModel):
    version: int = PROFILE_VERSION
    display_name: str = ""
    onboarding: OnboardingState = Field(default_factory=OnboardingState)
    preferences: Preferences = Field(default_factory=Preferences)


class MeResponse(BaseModel):
    user_id: str
    email: str
    is_admin: bool
    profile: Profile


# ── Profile: patch side ───────────────────────────────────────────────────


def _dedupe(values: list[str]) -> list[str]:
    """Order-preserving de-dup, so ["Pop","Pop"] cannot spend two of the cap."""
    seen: list[str] = []
    for value in values:
        if value not in seen:
            seen.append(value)
    return seen


class PreferencesPatch(BaseModel):
    # extra="forbid" throughout: a key the server silently drops is how a client
    # typo becomes "my setting won't save". Both halves ship from one deploy, so
    # there is no forward-compatibility argument for ignoring unknown keys.
    model_config = ConfigDict(extra="forbid")

    experience_level: ExperienceLevel | None = None
    genres: Annotated[list[Genre], AfterValidator(_dedupe)] | None = Field(
        default=None, max_length=MAX_GENRES
    )
    moods: Annotated[list[Mood], AfterValidator(_dedupe)] | None = Field(
        default=None, max_length=MAX_MOODS
    )
    primary_intent: PrimaryIntent | None = None
    typical_length: TypicalLength | None = None


class ProfilePatchRequest(BaseModel):
    """
    Partial update. Absent key means "leave alone", explicit null means "clear".

    That distinction is carried by `model_dump(exclude_unset=True)`, which is
    also why nothing here may use `exclude_none` — it would make clearing a
    preference impossible.
    """

    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, max_length=DISPLAY_NAME_MAX)
    preferences: PreferencesPatch | None = None
    # NOT a completed_at timestamp: the server stamps its own clock, so a client
    # cannot backdate or forge one. The response model is asymmetric with this
    # on purpose.
    onboarding_action: Literal["complete", "skip"] | None = None
