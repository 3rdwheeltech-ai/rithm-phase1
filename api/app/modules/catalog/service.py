"""
Catalog writes.

`create_track_in_txn` is unusual on purpose: it runs on a session handed in by
the caller rather than opening its own. That caller is generation's
finalize_job, and the session belongs to the *generation* engine — so the job
UPDATE, the track INSERT and the prompt_history INSERT are one transaction and
either all land or none do.

This module does NOT import app.modules.generation. It satisfies generation's
TrackWriter Protocol structurally; pyright verifies the match at the injection
site in main.py, which is the only place the two modules meet.

Role note: the session authenticates as rithm_generation, which by default has
no rights in the catalog schema. Migration 0002_catalog_generation_grants adds
exactly USAGE + INSERT on these two tables — no SELECT, no other tables.
"""
import json
from typing import Any
from uuid import UUID

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid_utils import uuid7

from app.modules.catalog.models import (
    DEFAULT_PROMPT_KIND,
    PROMPT_HISTORY_TABLE,
    PROMPT_KIND_FOR_JOB,
    TRACKS_TABLE,
    CreatedTrack,
)

logger = structlog.get_logger()


class CatalogService:

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
        """
        Insert one track plus its opening prompt_history row.

        Runs on the CALLER's session and never commits — the caller's context
        manager owns the transaction boundary.
        """
        track_id = UUID(str(uuid7()))

        insert_track = text(
            f"""
            INSERT INTO {TRACKS_TABLE}
                (id, user_id, source_job_id, genre, mood, bpm, vocal,
                 length_seconds, prompt, params, s3_wav_key, s3_mp3_key,
                 waveform_hash)
            VALUES
                (:id, :user_id, :source_job_id, :genre, :mood, :bpm,
                 :vocal, :length_seconds, :prompt, CAST(:params AS JSONB),
                 :s3_wav_key, :s3_mp3_key, :waveform_hash)
            ON CONFLICT (source_job_id) DO NOTHING
            RETURNING id
            """  # noqa: S608 — table name is a module constant, not input
        )
        inserted = (
            await session.execute(
                insert_track,
                {
                    "id": str(track_id),
                    "user_id": str(user_id),
                    "source_job_id": str(source_job_id),
                    # Denormalized out of params so list/filter queries can be
                    # indexed without unpacking JSONB on every row.
                    "genre": params.get("genre"),
                    "mood": params.get("mood"),
                    "bpm": params.get("bpm"),
                    "vocal": params.get("vocal", True),
                    "length_seconds": params.get("length_seconds"),
                    "prompt": prompt,
                    "params": json.dumps(params),
                    "s3_wav_key": s3_wav_key,
                    "s3_mp3_key": s3_mp3_key,
                    "waveform_hash": waveform_hash,
                },
            )
        ).first()

        if inserted is None:
            # The backstop fired: a track for this job already exists, so this
            # is a replayed completion. Adopt the existing row's id and skip the
            # prompt insert — writing it anyway would either violate the FK
            # (the id we generated was never inserted) or silently duplicate
            # the track's opening prompt.
            existing = (
                await session.execute(
                    text(
                        f"SELECT id FROM {TRACKS_TABLE} "  # noqa: S608
                        "WHERE source_job_id = :source_job_id"
                    ),
                    {"source_job_id": str(source_job_id)},
                )
            ).first()
            if existing is None:
                # DO NOTHING fired but the row is gone: only reachable if the
                # track was deleted between the two statements.
                raise RuntimeError(
                    f"track for job {source_job_id} conflicted but is absent"
                )
            logger.info(
                "track_already_exists",
                track_id=str(existing.id),
                source_job_id=str(source_job_id),
            )
            return {"track_id": UUID(str(existing.id)), "mp3_key": s3_mp3_key}

        await session.execute(
            text(
                f"""
                INSERT INTO {PROMPT_HISTORY_TABLE}
                    (id, track_id, prompt, delta_command, kind)
                VALUES
                    (:id, :track_id, :prompt, NULL, :kind)
                """  # noqa: S608 — table name is a module constant, not input
            ),
            {
                "id": str(UUID(str(uuid7()))),
                "track_id": str(track_id),
                "prompt": prompt,
                "kind": PROMPT_KIND_FOR_JOB.get(kind, DEFAULT_PROMPT_KIND),
            },
        )

        logger.info(
            "track_created",
            track_id=str(track_id),
            source_job_id=str(source_job_id),
        )
        return {"track_id": track_id, "mp3_key": s3_mp3_key}


# Module-level singleton, matching identity/service.py and generation/service.py.
catalog_service = CatalogService()
