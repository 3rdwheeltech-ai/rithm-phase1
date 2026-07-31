"""
The Protocols that cross this module's boundary, in both directions.

The import-linter independence contract forbids catalog/conversation/etc. from
importing app.modules.generation.service directly — and forbids generation from
importing them. Both directions are served structurally:

  GenerationService  what other modules consume FROM generation.
  TrackWriter        what generation consumes from catalog, WITHOUT importing
                     it. CatalogService satisfies this by shape alone; the
                     conformance check happens where main.py injects it.
"""
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
    ) -> CreatedTrack:
        ...


class GenerationService(Protocol):
    async def submit(
        self, *, user_id: UUID, kind: JobKind, params: GenerationParams
    ) -> UUID:
        ...

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
