"""
Generation wire DTOs and internal params.

Note the deliberate split between GenerationParams (internal — what lands in
request_payload and in the SQS envelope, with a single scalar `bpm`) and
GenerateRequest (public wire DTO, with a bpm_min/bpm_max *range*). The
range→scalar collapse happens in the public generate route, which is Day 3.
Keeping the two types distinct is what stops that collapse from leaking
backwards into the envelope.
"""
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal, Self, TypedDict
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from app.modules.generation.models import JobKind

# Cap each instrument as well as the list length. Without the per-item bound,
# `instruments` is an unguarded 10-slot text field and someone smuggles a
# 2000-character prompt through it.
Instrument = Annotated[str, Field(min_length=1, max_length=40)]

# Enum lists must match the catalog.tracks CHECKs; the Day-4 UI dropdowns
# read from these.


class Genre(StrEnum):
    POP = "Pop"
    HIP_HOP = "Hip-Hop"
    EDM = "EDM"
    LO_FI = "Lo-Fi"
    CINEMATIC = "Cinematic"
    ROCK = "Rock"
    COUNTRY = "Country"
    R_AND_B = "R&B"
    AMBIENT = "Ambient"


class Mood(StrEnum):
    HAPPY = "Happy"
    CALM = "Calm"
    ENERGETIC = "Energetic"
    DARK = "Dark"
    ROMANTIC = "Romantic"
    INSPIRATIONAL = "Inspirational"
    DRAMATIC = "Dramatic"


SSEEventType = Literal["queued", "running", "completed", "failed"]


class SSEEvent(TypedDict):
    """One frame on the SSE wire: `event: <type>\\ndata: <json>\\n\\n`."""

    event: SSEEventType
    data: dict[str, Any]


class GenerationParams(BaseModel):
    """Internal params — stored in request_payload, sent in the SQS envelope."""

    prompt: str = Field(min_length=1, max_length=2000)
    genre: Genre | None = None
    mood: Mood | None = None
    # The resolved scalar the worker conditions on, and the range it came from.
    # Both are kept: bpm is what catalog.tracks denormalises and indexes, and
    # bpm_min/bpm_max are what the Day-4 UI needs back to repopulate its slider.
    # The worker ignores the range.
    bpm: int | None = Field(default=None, ge=20, le=300)
    bpm_min: int | None = Field(default=None, ge=20, le=300)
    bpm_max: int | None = Field(default=None, ge=20, le=300)
    instruments: list[Instrument] = Field(default_factory=list, max_length=10)
    vocal: bool = True
    length_seconds: int = Field(default=90, ge=10, le=180)
    # Minted API-side at submit, never by the worker, and never null on the
    # wire from Day 3 onward — it is what makes a generation reproducible and
    # what makes "a variation is the same params with a different seed"
    # (TTM-04) a checkable statement rather than a hope.
    seed: int | None = None
    # Present only for refine_fresh. Carried through request_payload so
    # finalize_job can put it in prompt_history.delta_command without a
    # second query.
    delta_command: str | None = Field(default=None, max_length=500)


def resolve_bpm(lo: int | None, hi: int | None) -> int | None:
    """
    Collapse the request's BPM *range* onto the single INT everything downstream
    uses.

    The design's request DTO takes bpm_min/bpm_max; the SQS envelope and
    catalog.tracks.bpm are one scalar. Resolving here, once, at submit, is what
    stops that mismatch eating an afternoon on Day 4 when the UI sends a range
    and the track shows a single number. The original range is preserved in
    params alongside the resolved value, so nothing is lost.
    """
    if lo is None and hi is None:
        return None
    if lo is None:
        return hi
    if hi is None:
        return lo
    return (lo + hi) // 2


# ── Wire DTOs ──────────────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    genre: Genre | None = None
    mood: Mood | None = None
    bpm_min: int | None = Field(default=None, ge=20, le=300)
    bpm_max: int | None = Field(default=None, ge=20, le=300)
    instruments: list[Instrument] = Field(default_factory=list, max_length=10)
    vocal: bool = True
    length_seconds: int = Field(default=90, ge=10, le=180)

    @model_validator(mode="after")
    def _bpm_range_is_ordered(self) -> Self:
        if (
            self.bpm_min is not None
            and self.bpm_max is not None
            and self.bpm_min > self.bpm_max
        ):
            raise ValueError("bpm_min must be less than or equal to bpm_max")
        return self


class RefinementMode(StrEnum):
    FRESH = "fresh"
    # Accepted by the schema but rejected by the route with a 400. Modelling it
    # here rather than omitting it is deliberate: the client gets a written
    # explanation instead of a 422 about an unknown enum value.
    AUDIO_REFERENCE = "audio_reference"


class RefineRequest(BaseModel):
    delta_command: str = Field(min_length=1, max_length=500)
    refinement_mode: RefinementMode = RefinementMode.FRESH


class JobAccepted(BaseModel):
    job_id: UUID
    status: Literal["QUEUED"]
    sse_url: str
    created_at: datetime


# ── Dev-only ───────────────────────────────────────────────────────────────


class DevEnqueueRequest(BaseModel):
    params: GenerationParams | None = None
    kind: JobKind = "generate"


class DevEnqueueResponse(BaseModel):
    job_id: UUID
    sse_token: str
    sse_url: str
