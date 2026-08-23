"""
Catalog HTTP surface — the read half of /tracks.

This module owns GET and DELETE under /tracks; generation owns the POST verbs.
main.py registers generation's router first and every path param here is typed
UUID, so the two cannot collide — not today, where they differ by method, and
not for any future addition either.

Every read runs on get_session("catalog") as rithm_catalog, which already holds
SELECT (ops/db/00_init.sql). Day 3 adds no grant and no migration. If you find
yourself writing one, you are on the generation connection by mistake — that
role has only column-scoped SELECT (id, source_job_id) and will refuse.
"""

import base64
import binascii
from datetime import datetime
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.modules.catalog.models import PromptRow, TrackRow
from app.modules.catalog.schemas import (
    PromptHistoryEntry,
    TrackDetail,
    TrackSummary,
)
from app.modules.catalog.service import catalog_service
from app.shared.auth import require_user
from app.shared.aws import presign_get
from app.shared.exceptions import ResourceNotFoundException

logger = structlog.get_logger()

router = APIRouter(tags=["catalog"])

# Matches generation/service.py's _MP3_URL_TTL_SECONDS. Launch plan §2.1:
# playback is an S3 presigned GET, not a CloudFront-signed URL.
_URL_TTL_SECONDS = 900


def _encode_cursor(created_at: datetime, track_id: UUID) -> str:
    """Opaque to the client — the shape is ours to change."""
    raw = f"{created_at.isoformat()}|{track_id}".encode()
    return base64.urlsafe_b64encode(raw).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    """
    A malformed cursor is a 400, not a 500 and not a silent reset to page 1.

    Silently resetting is the worst of the three: the client believes it is
    paging forward while looping over page 1 forever.
    """
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        timestamp, _, track_id = raw.partition("|")
        return datetime.fromisoformat(timestamp), UUID(track_id)
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Malformed cursor.") from exc


def _summary(track: TrackRow) -> TrackSummary:
    return TrackSummary(
        id=track.id,
        prompt=track.prompt,
        genre=track.genre,
        mood=track.mood,
        bpm=track.bpm,
        vocal=track.vocal,
        length_seconds=track.length_seconds,
        mp3_url=presign_get(track.s3_mp3_key, expires=_URL_TTL_SECONDS),
        created_at=track.created_at,
    )


def _prompt_entry(row: PromptRow) -> PromptHistoryEntry:
    return PromptHistoryEntry.model_validate(
        {
            "id": row.id,
            "prompt": row.prompt,
            "delta_command": row.delta_command,
            "kind": row.kind,
            "created_at": row.created_at,
        }
    )


@router.get("/tracks", response_model=list[TrackSummary])
async def list_tracks(
    response: Response,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    user_id: UUID = Depends(require_user),
) -> list[TrackSummary]:
    """
    A user's tracks, newest first (TTM-05).

    Returns a bare JSON array; pagination travels in headers (design §5.2):

      X-Total-Count   every non-deleted track this user owns
      X-Next-Cursor   the cursor for the next page, OMITTED on the last page
      Link            the same cursor, RFC 8288 shaped, also omitted at the end

    X-Next-Cursor is a deliberate addition to the design's contract. Link is the
    RFC-correct answer and it stays — but parsing it in JavaScript is genuinely
    annoying, and without the plain header Day 4 reimplements an RFC 8288 parser
    inside a TanStack Query hook. Two headers, one line of server code.

    All three are listed in CORSMiddleware's expose_headers; a browser cannot
    read a non-simple response header otherwise, and the failure looks like
    "works in curl, undefined in the browser".
    """
    decoded = _decode_cursor(cursor) if cursor else None
    tracks, has_more, total = await catalog_service.list_tracks(
        user_id=user_id, limit=limit, cursor=decoded
    )

    response.headers["X-Total-Count"] = str(total)
    if has_more and tracks:
        last = tracks[-1]
        next_cursor = _encode_cursor(last.created_at, last.id)
        response.headers["X-Next-Cursor"] = next_cursor
        response.headers["Link"] = (
            f'</api/v1/tracks?cursor={next_cursor}&limit={limit}>; rel="next"'
        )
    return [_summary(track) for track in tracks]


@router.get("/tracks/{track_id}", response_model=TrackDetail)
async def get_track(
    track_id: UUID,
    user_id: UUID = Depends(require_user),
) -> TrackDetail:
    """
    One track with its full prompt lineage.

    Both URLs are presigned through shared/aws.py's presign_get — the shared
    implementation Day 2 handed over. Do not re-derive one here.
    """
    track = await catalog_service.get_track(track_id=track_id, user_id=user_id)
    if track is None:
        raise ResourceNotFoundException("Track", str(track_id))

    history = await catalog_service.get_prompt_history(track_id=track_id)
    return TrackDetail(
        **_summary(track).model_dump(),
        wav_url=presign_get(track.s3_wav_key, expires=_URL_TTL_SECONDS),
        lyrics=track.lyrics,
        waveform_hash=track.waveform_hash,
        prompt_history=[_prompt_entry(row) for row in history],
    )


@router.get("/tracks/{track_id}/prompts", response_model=list[PromptHistoryEntry])
async def get_track_prompts(
    track_id: UUID,
    user_id: UUID = Depends(require_user),
) -> list[PromptHistoryEntry]:
    """
    A track's prompt history on its own (PE-04).

    The same query the detail route runs, behind the same ownership check —
    worth its one route because Day 4 may want the lineage without paying for
    the full detail payload and two presigns.
    """
    track = await catalog_service.get_track(track_id=track_id, user_id=user_id)
    if track is None:
        raise ResourceNotFoundException("Track", str(track_id))

    history = await catalog_service.get_prompt_history(track_id=track_id)
    return [_prompt_entry(row) for row in history]


@router.delete("/tracks/{track_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_track(
    track_id: UUID,
    user_id: UUID = Depends(require_user),
) -> Response:
    """
    Soft-delete a track. 204 when this call deleted it, 404 otherwise.

    A second DELETE is a 404 rather than a 204: the track is already gone, and
    reporting success would let a client believe it had just removed something.
    """
    deleted = await catalog_service.soft_delete_track(
        track_id=track_id, user_id=user_id
    )
    if not deleted:
        raise ResourceNotFoundException("Track", str(track_id))
    logger.info("track_deleted", track_id=str(track_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
