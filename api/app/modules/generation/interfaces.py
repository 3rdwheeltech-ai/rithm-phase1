"""
The Protocol other modules consume.

The import-linter independence contract forbids catalog/conversation/etc. from
importing app.modules.generation.service directly. When Day 2 wires catalog
into the completion path, it depends on this Protocol, not the concrete module.
"""
from typing import Protocol
from uuid import UUID

from app.modules.generation.models import JobKind
from app.modules.generation.schemas import GenerationParams
from app.modules.generation.sse_hub import SSEHub


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
