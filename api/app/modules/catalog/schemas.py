"""
Catalog wire DTOs.

`feedback` is deliberately absent from TrackDetail. PE-06 is cut for launch, and
a field that is structurally always null is a small lie the Day-4 client would
have to model and then unmodel. Add it when the feedback endpoint ships.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel


class TrackSummary(BaseModel):
    """
    One track in a list response.

    mp3_url is on the SUMMARY, not just the detail, on purpose: Day 4 wires
    Recents from GET /tracks and the Player from mp3_url, and a list without
    playback URLs forces a round-trip per click. Presigning is a local signing
    operation with no network call, so twenty of them cost microseconds.

    NOTE FOR CLIENTS: mp3_url expires 15 minutes after this response is built.
    On a 403 from S3, refetch the page rather than showing a broken player.
    """

    id: UUID
    prompt: str
    genre: str | None
    mood: str | None
    bpm: int | None
    vocal: bool
    length_seconds: int
    mp3_url: str
    created_at: datetime


class PromptHistoryEntry(BaseModel):
    id: UUID
    prompt: str
    # NULL for an initial prompt, populated for a refinement.
    delta_command: str | None
    kind: Literal["initial", "refine_fresh", "refine_audio", "remix", "variation"]
    created_at: datetime


class TrackDetail(TrackSummary):
    """
    Full track view.

    wav_url supports TTM-03 preview-before-download and carries the same
    15-minute expiry as mp3_url.
    """

    wav_url: str
    waveform_hash: str
    prompt_history: list[PromptHistoryEntry]
