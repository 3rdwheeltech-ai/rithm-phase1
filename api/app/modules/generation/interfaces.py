"""
The Protocols that cross this module's boundary, in both directions.

The import-linter independence contract forbids catalog/conversation/etc. from
importing app.modules.generation.service directly — and forbids generation from
importing them. Both directions are served structurally:

  GenerationService  what other modules consume FROM generation.
  TrackWriter        what generation consumes from catalog, WITHOUT importing
                     it. CatalogService satisfies this by shape alone; the
                     conformance check happens where main.py injects it.
  TrackReader        the read-side twin, added Day 3 for variation/refine.

Why TrackReader exists rather than a widened grant: rithm_generation holds
column-scoped SELECT (id, source_job_id) on catalog.tracks and nothing more,
which is nowhere near enough to read a parent track's prompt and params. The
narrowness is the point — generation cannot read users' track content. So the
parent lookup runs on the CATALOG connection as rithm_catalog, before the job
transaction opens, and reaches generation through this Protocol.
"""

from datetime import datetime
from typing import Any, Protocol, TypedDict
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.generation.models import JobKind
from app.modules.generation.schemas import GenerationParams
from app.modules.generation.sse_hub import SSEHub


class CreatedTrack(TypedDict):
    """What a track write hands back to finalize_job."""

    track_id: UUID
    mp3_key: str


class ParentTrack(TypedDict):
    """
    What a variation/refine submit needs to know about the track it derives from.

    Declared a SECOND time, identically, in catalog/models.py — catalog may not
    import generation, and TypedDict assignability is structural, so two
    identical declarations satisfy each other. Same arrangement as CreatedTrack,
    for the same reason. Keep the two in sync.
    """

    track_id: UUID
    user_id: UUID
    prompt: str
    params: dict[str, Any]
    length_seconds: int


class TrackWriter(Protocol):
    """
    Writes a catalog track inside SOMEONE ELSE'S transaction.

    The session argument is the caller's — finalize_job passes its open
    generation session so the job UPDATE and both catalog INSERTs commit or
    roll back together. The implementation must not open its own session, and
    must not commit: the caller's context manager owns the boundary.

    This is what makes the cross-schema write atomic despite the two schemas
    being owned by different roles; migration 0002_catalog_generation_grants
    grants rithm_generation the narrow INSERT it needs.
    """

    async def create_track_in_txn(
        self,
        session: AsyncSession,
        *,
        user_id: UUID,
        source_job_id: UUID,
        kind: str,
        prompt: str,
        params: dict[str, Any],
        s3_wav_key: str,
        s3_mp3_key: str,
        waveform_hash: str,
        delta_command: str | None = None,
    ) -> CreatedTrack:
        # delta_command lands in prompt_history.delta_command: NULL for an
        # initial prompt, populated for a refinement. The default and the
        # keyword name must match catalog/service.py EXACTLY — a mismatch on
        # either breaks structural conformance, and pyright reports it at the
        # injection site in main.py, a long way from the cause.
        ...


class TrackReader(Protocol):
    """
    Reads the parent track a variation or refine derives from.

    Runs on catalog's OWN connection (rithm_catalog), not the caller's session,
    and outside any transaction — the read happens before the job insert opens
    one. That is what keeps finalize_job's proven atomic three-write path from
    growing a second connection inside its transaction boundary.

    Returns None for both "no such track" and "not yours". The caller turns that
    into a 404; a 403 would tell an attacker the track exists.
    """

    async def get_track_for_generation(
        self, *, track_id: UUID, user_id: UUID
    ) -> ParentTrack | None: ...


class GenerationService(Protocol):
    async def submit(
        self,
        *,
        user_id: UUID,
        kind: JobKind,
        params: GenerationParams,
        parent_track_id: UUID | None = None,
        rate_limit: int | None = None,
    ) -> tuple[UUID, datetime]: ...

    async def finalize_job(
        self,
        *,
        hub: SSEHub,
        job_id: UUID,
        status: str,
        s3_wav_key: str | None = None,
        s3_mp3_key: str | None = None,
        duration_seconds: int | None = None,
        waveform_hash: str | None = None,
        worker_id: str | None = None,
        error: str | None = None,
    ) -> None:
        # Explicit keyword params rather than the spec's **outputs: untyped
        # **kwargs fails pyright strict, and `**outputs: Any` trips ANN401.
        ...
