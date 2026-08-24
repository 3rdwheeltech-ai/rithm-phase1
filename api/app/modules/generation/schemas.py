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

# ACE-Step publishes no documented lyric cap, so this bound is ours: comfortably
# above a long song, well below "the prompt field with the guard rails off".
# Mirrored in web/src/types/api.ts and pinned there, the same way prompt's 2000 is.
LYRICS_MAX_LENGTH = 3000

# Bounded well under the VARCHAR(120) column so a title can never be the thing
# that fails an INSERT. Mirrored in web/src/types/api.ts and pinned there, the
# same way prompt's 2000 is.
TITLE_MAX_LENGTH = 80

# What the lyric prompt box accepts in Prompt mode. Short on purpose: it is a
# brief, not a draft. The draft is what `write` mode is for.
LYRICS_PROMPT_MAX_LENGTH = 600

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


class LyricsMode(StrEnum):
    """
    Where the words come from — and ONLY that.

    It does not decide whether Bedrock is asked: `vocal and lyrics is None` is
    what does, in both WRITE and PROMPT. All this says is whether
    `lyrics_prompt` is honoured.
    """

    WRITE = "write"  # the user's own words (or an empty box)
    PROMPT = "prompt"  # a brief; the model writes the words
    INSTRUMENTAL = "instrumental"


class Voice(StrEnum):
    """
    The requested lead vocal. A hint the worker folds into ACE-Step's caption —
    there is no gender parameter to set, so it is never a guarantee.
    """

    AUTO = "auto"
    FEMALE = "female"
    MALE = "male"


# Where the words in `lyrics` came from. The one field that makes this feature
# debuggable from a `SELECT params FROM catalog.tracks`.
#   user     they typed the words
#   model    the authoring model wrote them
#   acestep  the model was asked and could not answer; ACE-Step's own planner
#            gets the empty field, exactly as it did before this existed
#   None     instrumental — there are no words
LyricsSource = Literal["user", "model", "acestep"]


SSEEventType = Literal["queued", "running", "completed", "failed"]


class SSEEvent(TypedDict):
    """One frame on the SSE wire: `event: <type>\\ndata: <json>\\n\\n`."""

    event: SSEEventType
    data: dict[str, Any]


class GenerationParams(BaseModel):
    """Internal params — stored in request_payload, sent in the SQS envelope."""

    prompt: str = Field(min_length=1, max_length=2000)
    # The track's name. Supplied by the user or written by the title model at
    # submit; never null from the generate route, because write_title has a
    # heuristic floor. A variation inherits its parent's unchanged.
    title: str | None = Field(default=None, max_length=TITLE_MAX_LENGTH)
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
    # The user's own words, or None to let ACE-Step's LM planning phase write
    # them. Never both this and vocal=False — GenerateRequest rejects that pair
    # at the edge, and the worker forces [Instrumental] if one ever gets through.
    lyrics: str | None = Field(default=None, max_length=LYRICS_MAX_LENGTH)
    # A caption hint the worker folds in after mood. Params-JSONB only: nothing
    # lists or filters on it, so it needs no column.
    voice: Voice = Voice.AUTO
    # Provenance, kept for the same reason bpm_min/bpm_max are kept next to the
    # resolved bpm: the resolved value alone cannot answer "where did this come
    # from?". The worker reads neither.
    lyrics_prompt: str | None = Field(default=None, max_length=LYRICS_PROMPT_MAX_LENGTH)
    lyrics_source: LyricsSource | None = None
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
    # Optional: an empty box means "name it for me", which is what the title
    # model is for. Not the same as a blank string — the validator below
    # normalises one into the other.
    title: str | None = Field(default=None, max_length=TITLE_MAX_LENGTH)
    genre: Genre | None = None
    mood: Mood | None = None
    bpm_min: int | None = Field(default=None, ge=20, le=300)
    bpm_max: int | None = Field(default=None, ge=20, le=300)
    instruments: list[Instrument] = Field(default_factory=list, max_length=10)
    vocal: bool = True
    length_seconds: int = Field(default=90, ge=10, le=180)
    lyrics: str | None = Field(default=None, max_length=LYRICS_MAX_LENGTH)
    # Defaulted, not required, so an SPA cached in a browser keeps working
    # through the deploy window — the exact concern commit e659016 had to
    # solve once already.
    lyrics_mode: LyricsMode = LyricsMode.WRITE
    lyrics_prompt: str | None = Field(default=None, max_length=LYRICS_PROMPT_MAX_LENGTH)
    voice: Voice = Voice.AUTO

    @model_validator(mode="after")
    def _bpm_range_is_ordered(self) -> Self:
        if (
            self.bpm_min is not None
            and self.bpm_max is not None
            and self.bpm_min > self.bpm_max
        ):
            raise ValueError("bpm_min must be less than or equal to bpm_max")
        return self

    @model_validator(mode="after")
    def _lyric_fields_agree(self) -> Self:
        """
        Normalise blank text away, then refuse the pairs that cannot both be true.

        Three text fields and two flags can disagree in more ways than they can
        agree, so the biconditional is stated once, here, rather than
        re-derived at every reader. Blank-to-None first: a box the user tabbed
        through means "nothing", not "three spaces" — ACE-Step reads an empty
        lyrics field as "write your own words".

        lyrics + vocal=False is unrepresentable downstream: the worker's
        [Instrumental] token IS the lyrics field, so one of the two would have
        to silently win. A 422 here means nobody has to guess which.
        """
        for field in ("title", "lyrics", "lyrics_prompt"):
            value: str | None = getattr(self, field)
            if value is None:
                continue
            setattr(self, field, value.strip() or None)

        # Deploy-window compatibility, and ONLY that. An SPA cached before
        # lyrics_mode existed sends `vocal: false` and no mode at all, which
        # would otherwise fail the biconditional below and 422 every
        # instrumental request from a stale tab — and CloudFront keeps serving
        # that JS for a while after the API rolls. `model_fields_set` is what
        # makes this safe: it fires only when the field was OMITTED, so a
        # current client, which always sends one, can never reach it. An
        # EXPLICIT lyrics_mode='write' with vocal=false is still a 422.
        if "lyrics_mode" not in self.model_fields_set and not self.vocal:
            self.lyrics_mode = LyricsMode.INSTRUMENTAL

        instrumental = self.lyrics_mode is LyricsMode.INSTRUMENTAL
        if instrumental != (not self.vocal):
            raise ValueError(
                "lyrics_mode and vocal must agree — "
                "'instrumental' means vocal=false and nothing else does"
            )
        if instrumental and (self.lyrics or self.lyrics_prompt):
            raise ValueError(
                "lyrics cannot be supplied with vocal=false — an instrumental "
                "track has no words to sing"
            )
        if self.lyrics_mode is LyricsMode.WRITE and self.lyrics_prompt:
            raise ValueError("lyrics_prompt belongs to lyrics_mode='prompt'")
        if self.lyrics_mode is LyricsMode.PROMPT and self.lyrics:
            raise ValueError("lyrics belongs to lyrics_mode='write'")
        # Not an error: a gender for a track with no singer is meaningless,
        # not contradictory, and 422-ing a leftover slider position is
        # user-hostile.
        if instrumental:
            self.voice = Voice.AUTO
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


class JobStatusResponse(BaseModel):
    """
    GET /jobs/{job_id} — the polling fallback for a client whose stream died.

    Named ...Response because `JobStatus` is already the lifecycle StrEnum in
    models.py; two things called JobStatus in one module is a trap.
    """

    job_id: UUID
    status: Literal["QUEUED", "RUNNING", "COMPLETED", "FAILED", "DEAD_LETTERED"]
    kind: str
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None
    # Populated once the catalog row exists.
    track_id: UUID | None = None
    # Presigned, 15-minute TTL, and only on a COMPLETED job.
    mp3_url: str | None = None


# ── Dev-only ───────────────────────────────────────────────────────────────


class DevEnqueueRequest(BaseModel):
    params: GenerationParams | None = None
    kind: JobKind = "generate"


class DevEnqueueResponse(BaseModel):
    job_id: UUID
    sse_token: str
    sse_url: str
