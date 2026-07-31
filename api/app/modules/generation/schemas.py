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
from typing import Any, Literal, TypedDict
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.generation.models import JobKind

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
    bpm: int | None = Field(default=None, ge=20, le=300)
    instruments: list[str] = Field(default_factory=list, max_length=10)
    vocal: bool = True
    length_seconds: int = Field(default=90, ge=10, le=180)
    seed: int | None = None


# ── Wire DTOs — the public generate routes are Day 3; shapes defined now ────


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    genre: Genre | None = None
    mood: Mood | None = None
    bpm_min: int | None = Field(default=None, ge=20, le=300)
    bpm_max: int | None = Field(default=None, ge=20, le=300)
    instruments: list[str] = Field(default_factory=list, max_length=10)
    vocal: bool = True
    length_seconds: int = Field(default=90, ge=10, le=180)


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
