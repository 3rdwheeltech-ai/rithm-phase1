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
from datetime import datetime
from typing import Any, cast
from uuid import UUID

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid_utils import uuid7

from app.modules.catalog.models import (
    DEFAULT_PROMPT_KIND,
    PARENT_TRACK_COLUMNS,
    PROMPT_HISTORY_COLUMNS,
    PROMPT_HISTORY_TABLE,
    PROMPT_KIND_FOR_JOB,
    TRACK_COLUMNS,
    TRACKS_TABLE,
    CreatedTrack,
    ParentTrack,
    PromptRow,
    TrackRow,
)
from app.shared.db import get_session

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
        delta_command: str | None = None,
    ) -> CreatedTrack:
        """
        Insert one track plus its opening prompt_history row.

        Runs on the CALLER's session and never commits — the caller's context
        manager owns the transaction boundary.

        delta_command is NULL for an initial prompt and populated for a
        refinement, which is exactly what the column is for. The keyword name
        and default must match generation/interfaces.py's TrackWriter EXACTLY:
        structural conformance is what binds the two, and pyright reports a
        mismatch at main.py's injection site, a long way from the cause.
        """
        track_id = UUID(str(uuid7()))

        insert_track = text(
            f"""
            INSERT INTO {TRACKS_TABLE}
                (id, user_id, source_job_id, title, genre, mood, bpm, vocal,
                 length_seconds, prompt, lyrics, params, s3_wav_key,
                 s3_mp3_key, waveform_hash)
            VALUES
                (:id, :user_id, :source_job_id, :title, :genre, :mood, :bpm,
                 :vocal, :length_seconds, :prompt, :lyrics,
                 CAST(:params AS JSONB),
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
                    # NULL only for a job submitted by an API old enough not to
                    # have resolved one — the generate route always sends one.
                    "title": params.get("title"),
                    "genre": params.get("genre"),
                    "mood": params.get("mood"),
                    "bpm": params.get("bpm"),
                    "vocal": params.get("vocal", True),
                    "length_seconds": params.get("length_seconds"),
                    "prompt": prompt,
                    # The column has existed since the baseline migration and
                    # TrackRow already reads it; before user lyrics there was
                    # simply nothing to put in it. NULL means the model wrote
                    # the words (or there are none) — same as the API's None.
                    "lyrics": params.get("lyrics"),
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
                    (:id, :track_id, :prompt, :delta_command, :kind)
                """  # noqa: S608 — table name is a module constant, not input
            ),
            {
                "id": str(UUID(str(uuid7()))),
                "track_id": str(track_id),
                "prompt": prompt,
                "delta_command": delta_command,
                "kind": PROMPT_KIND_FOR_JOB.get(kind, DEFAULT_PROMPT_KIND),
            },
        )

        logger.info(
            "track_created",
            track_id=str(track_id),
            source_job_id=str(source_job_id),
        )
        return {"track_id": track_id, "mp3_key": s3_mp3_key}

    # ── Reads ──────────────────────────────────────────────────────────────
    #
    # Unlike create_track_in_txn these open their OWN sessions on the catalog
    # engine, as rithm_catalog, which already holds SELECT. They are ordinary
    # reads outside any transaction, which is exactly why the variation/refine
    # parent lookup can be one of them without touching finalize_job's proven
    # atomic write path.

    async def get_track_for_generation(
        self, *, track_id: UUID, user_id: UUID
    ) -> ParentTrack | None:
        """
        The parent a variation or refine derives from.

        Satisfies generation's TrackReader Protocol structurally. Returns None
        for both "no such track" and "not yours" — the caller turns either into
        a 404, because a 403 would tell an attacker the track exists.

        The keyword names track_id/user_id are load-bearing: they must match
        the Protocol exactly or structural conformance breaks.
        """
        async with get_session("catalog") as session:
            row = (
                (
                    await session.execute(
                        text(
                            f"SELECT {PARENT_TRACK_COLUMNS} "  # noqa: S608
                            f"FROM {TRACKS_TABLE} "
                            "WHERE id = CAST(:id AS uuid) "
                            "  AND user_id = CAST(:user_id AS uuid) "
                            "  AND deleted_at IS NULL"
                        ),
                        {"id": str(track_id), "user_id": str(user_id)},
                    )
                )
                .mappings()
                .first()
            )

        if row is None:
            return None
        return {
            "track_id": UUID(str(row["id"])),
            "user_id": UUID(str(row["user_id"])),
            "prompt": str(row["prompt"]),
            "params": _decode_params(row["params"]),
            "length_seconds": int(row["length_seconds"]),
        }

    async def list_tracks(
        self,
        *,
        user_id: UUID,
        limit: int,
        cursor: tuple[datetime, UUID] | None,
    ) -> tuple[list[TrackRow], bool, int]:
        """
        One page of a user's tracks, newest first, plus a has-more flag and the
        total.

        KEYSET, not OFFSET. Offset pagination shifts rows under the user every
        time a generation completes, which on this product is constantly — page
        2 would silently repeat or skip a track. The (created_at, id) row
        comparison breaks ties deterministically; ids are uuid7 and therefore
        time-ordered, so the tiebreak is monotone with the sort.

        Fetches limit+1 and returns limit: the extra row's existence is how we
        know whether there is a next page, without a second count query.

        The CAST(... AS timestamptz/uuid) wrappers are MANDATORY, not
        stylistic. On the first page the cursor params are NULL, and asyncpg
        cannot infer a type for a NULL parameter — without the casts the very
        first call raises "could not determine data type of parameter".
        """
        # Pass the datetime OBJECT, not an ISO string. The CAST below types the
        # parameter as timestamptz, and asyncpg then refuses a str outright:
        # "expected a datetime.date or datetime.datetime instance, got 'str'".
        # The CAST is still mandatory for the first page, where this is NULL and
        # asyncpg has nothing to infer from. Both halves are needed, and only a
        # real driver catches the second one.
        cursor_ts = cursor[0] if cursor else None
        cursor_id = str(cursor[1]) if cursor else None

        async with get_session("catalog") as session:
            rows = (
                (
                    await session.execute(
                        text(
                            f"""
                        SELECT {TRACK_COLUMNS}
                          FROM {TRACKS_TABLE}
                         WHERE user_id = CAST(:user_id AS uuid)
                           AND deleted_at IS NULL
                           AND (CAST(:cursor_ts AS timestamptz) IS NULL
                                OR (created_at, id) <
                                   (CAST(:cursor_ts AS timestamptz),
                                    CAST(:cursor_id AS uuid)))
                         ORDER BY created_at DESC, id DESC
                         LIMIT :limit_plus_one
                        """  # noqa: S608 — constants, not input
                        ),
                        {
                            "user_id": str(user_id),
                            "cursor_ts": cursor_ts,
                            "cursor_id": cursor_id,
                            "limit_plus_one": limit + 1,
                        },
                    )
                )
                .mappings()
                .all()
            )

            total = (
                await session.execute(
                    text(
                        f"SELECT count(*) FROM {TRACKS_TABLE} "  # noqa: S608
                        "WHERE user_id = CAST(:user_id AS uuid) "
                        "  AND deleted_at IS NULL"
                    ),
                    {"user_id": str(user_id)},
                )
            ).scalar_one()

        has_more = len(rows) > limit
        tracks = [TrackRow.from_row(row) for row in rows[:limit]]
        return tracks, has_more, int(total)

    async def get_track(self, *, track_id: UUID, user_id: UUID) -> TrackRow | None:
        """
        One track, or None when it does not exist, is deleted, or is not theirs.

        Ownership lives in the WHERE clause rather than a post-fetch check, so
        a miss is a clean 404 with no branch for the caller to get wrong.
        """
        async with get_session("catalog") as session:
            row = (
                (
                    await session.execute(
                        text(
                            f"SELECT {TRACK_COLUMNS} "  # noqa: S608
                            f"FROM {TRACKS_TABLE} "
                            "WHERE id = CAST(:id AS uuid) "
                            "  AND user_id = CAST(:user_id AS uuid) "
                            "  AND deleted_at IS NULL"
                        ),
                        {"id": str(track_id), "user_id": str(user_id)},
                    )
                )
                .mappings()
                .first()
            )
        return TrackRow.from_row(row) if row else None

    async def get_prompt_history(self, *, track_id: UUID) -> list[PromptRow]:
        """
        A track's prompt lineage, oldest first.

        Deliberately a SECOND query rather than a join onto get_track: a join
        would multiply the track row by the history length and we would
        de-duplicate it in Python for no gain. Callers must have already
        established ownership of track_id.
        """
        async with get_session("catalog") as session:
            rows = (
                (
                    await session.execute(
                        text(
                            f"SELECT {PROMPT_HISTORY_COLUMNS} "  # noqa: S608
                            f"FROM {PROMPT_HISTORY_TABLE} "
                            "WHERE track_id = CAST(:track_id AS uuid) "
                            "ORDER BY created_at ASC"
                        ),
                        {"track_id": str(track_id)},
                    )
                )
                .mappings()
                .all()
            )
        return [PromptRow.from_row(row) for row in rows]

    async def soft_delete_track(self, *, track_id: UUID, user_id: UUID) -> bool:
        """
        Mark a track deleted. True if this call did it, False if there was
        nothing to delete.

        Same WHERE ... RETURNING idiom as everywhere else in this repo: the
        ownership check and the idempotency guard are both folded into the one
        statement, so a second DELETE is a clean 404 rather than a 204 lie.

        S3 objects are NOT removed. Soft delete means recoverable, the assets
        bucket is cheap, and object lifecycle is a Phase-2 job. A presigned URL
        minted before the delete stays valid for up to 15 minutes — an
        accepted, bounded consequence, not something to engineer around.
        """
        async with get_session("catalog") as session:
            row = (
                await session.execute(
                    text(
                        f"""
                        UPDATE {TRACKS_TABLE} SET deleted_at = now()
                         WHERE id = CAST(:id AS uuid)
                           AND user_id = CAST(:user_id AS uuid)
                           AND deleted_at IS NULL
                        RETURNING id
                        """  # noqa: S608 — table name is a module constant
                    ),
                    {"id": str(track_id), "user_id": str(user_id)},
                )
            ).first()
        return row is not None


def _decode_params(value: object) -> dict[str, Any]:
    """
    params as a dict, whichever way the driver hands it over.

    Mirrors generation/service.py's _decode_payload: asyncpg's JSONB codec
    normally decodes this already, but accepting a str keeps the function
    honest against a codec change and against test doubles.
    """
    if isinstance(value, str):
        value = json.loads(value)
    if isinstance(value, dict):
        return cast(dict[str, Any], value)
    return {}


# Module-level singleton, matching identity/service.py and generation/service.py.
catalog_service = CatalogService()
