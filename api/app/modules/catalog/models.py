"""
Schema contract for `catalog.tracks` and `catalog.prompt_history`.

Deliberately NOT a SQLAlchemy ORM model, for the same reasons recorded in
generation/models.py: this codebase has no declarative Base, persistence is raw
`text()` SQL, and migrations/catalog/env.py sets `target_metadata = None`
because migrations are hand-written DDL.

The tables already exist (migrations/catalog/versions/0001_catalog_baseline.py).
Nothing here migrates them.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, TypedDict
from uuid import UUID

from sqlalchemy import RowMapping

TRACKS_TABLE = "catalog.tracks"
PROMPT_HISTORY_TABLE = "catalog.prompt_history"


class CreatedTrack(TypedDict):
    """
    What create_track_in_txn hands back.

    Deliberately declared here as well as in generation/interfaces.py rather
    than shared between them: the module-independence contract forbids catalog
    from importing generation. TypedDict assignability is structural, so two
    identically-shaped declarations satisfy each other — which is precisely the
    decoupling the Protocol is for. Keep the two in sync.
    """

    track_id: UUID
    mp3_key: str


class ParentTrack(TypedDict):
    """
    What get_track_for_generation hands back to a variation/refine submit.

    Declared here AND in generation/interfaces.py, identically, for the same
    reason CreatedTrack is: catalog may not import generation, and TypedDict
    assignability is structural, so two identical declarations satisfy each
    other. Keep the two in sync.
    """

    track_id: UUID
    user_id: UUID
    prompt: str
    params: dict[str, Any]
    length_seconds: int


# The UI dropdowns must match these exactly. They are NOT enforced by a CHECK
# constraint — 02_catalog.sql deliberately commented the genre/mood CHECKs out
# ("values are open-ended"), so these tuples are the only place the vocabulary
# is written down.
GENRES: tuple[str, ...] = (
    "Pop",
    "Hip-Hop",
    "EDM",
    "Lo-Fi",
    "Cinematic",
    "Rock",
    "Country",
    "R&B",
    "Ambient",
)
MOODS: tuple[str, ...] = (
    "Happy",
    "Calm",
    "Energetic",
    "Dark",
    "Romantic",
    "Inspirational",
    "Dramatic",
)

# Mirrors the prompt_kind_vals CHECK constraint. Note `remix` is valid here but
# is NOT a generation.jobs kind — the two vocabularies differ on purpose, which
# is exactly why the map below exists instead of passing job kind through.
PromptKind = Literal["initial", "refine_fresh", "refine_audio", "remix", "variation"]
PROMPT_KINDS: frozenset[str] = frozenset(
    {"initial", "refine_fresh", "refine_audio", "remix", "variation"}
)

# generation.jobs.kind -> prompt_history.kind. A `generate` job produces the
# track's *initial* prompt entry; the names do not line up, so never pass the
# job kind straight through.
PROMPT_KIND_FOR_JOB: dict[str, PromptKind] = {
    "generate": "initial",
    "variation": "variation",
    "refine_fresh": "refine_fresh",
    "refine_audio": "refine_audio",
}
DEFAULT_PROMPT_KIND: PromptKind = "initial"


@dataclass(frozen=True, slots=True)
class TrackRow:
    """One row of catalog.tracks, typed."""

    id: UUID
    user_id: UUID
    source_job_id: UUID
    genre: str | None
    mood: str | None
    bpm: int | None
    vocal: bool
    length_seconds: int
    inference_steps: int
    prompt: str
    lyrics: str | None
    ref_audio_s3_key: str | None
    s3_wav_key: str
    s3_mp3_key: str
    waveform_hash: str
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None

    @classmethod
    def from_row(cls, row: RowMapping) -> "TrackRow":
        return cls(
            id=row["id"],
            user_id=row["user_id"],
            source_job_id=row["source_job_id"],
            genre=row["genre"],
            mood=row["mood"],
            bpm=row["bpm"],
            vocal=row["vocal"],
            length_seconds=row["length_seconds"],
            inference_steps=row["inference_steps"],
            prompt=row["prompt"],
            lyrics=row["lyrics"],
            ref_audio_s3_key=row["ref_audio_s3_key"],
            s3_wav_key=row["s3_wav_key"],
            s3_mp3_key=row["s3_mp3_key"],
            # CHAR(64) comes back blank-padded; strip so callers can compare it
            # to a freshly computed hex digest without a length surprise.
            waveform_hash=str(row["waveform_hash"]).strip(),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            deleted_at=row["deleted_at"],
        )


@dataclass(frozen=True, slots=True)
class PromptRow:
    """One row of catalog.prompt_history, typed."""

    id: UUID
    prompt: str
    delta_command: str | None
    kind: str
    created_at: datetime

    @classmethod
    def from_row(cls, row: RowMapping) -> "PromptRow":
        return cls(
            id=row["id"],
            prompt=row["prompt"],
            delta_command=row["delta_command"],
            kind=row["kind"],
            created_at=row["created_at"],
        )


# Column list shared by the SELECTs in service.py — keeps them in sync with
# TrackRow.from_row above. `params` is excluded: it is write-mostly and callers
# that want it should ask for it explicitly rather than pay for the JSONB on
# every list query.
TRACK_COLUMNS = (
    "id, user_id, source_job_id, genre, mood, bpm, vocal, length_seconds, "
    "inference_steps, prompt, lyrics, ref_audio_s3_key, s3_wav_key, "
    "s3_mp3_key, waveform_hash, created_at, updated_at, deleted_at"
)

# The ONE query that needs `params`: a variation copies the parent's generation
# parameters wholesale. Given its own column list rather than widening
# TRACK_COLUMNS, so every list query does not start paying for the JSONB.
PARENT_TRACK_COLUMNS = "id, user_id, prompt, params, length_seconds"

PROMPT_HISTORY_COLUMNS = "id, prompt, delta_command, kind, created_at"
