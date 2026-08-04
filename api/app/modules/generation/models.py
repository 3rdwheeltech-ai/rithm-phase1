"""
Schema contract for `generation.jobs`.

Deliberately NOT a SQLAlchemy ORM model. This codebase has no declarative Base:
persistence is raw `text()` SQL with schema-qualified names (see
identity/service.py and shared/auth.py), and migrations/generation/env.py
records the reason — `target_metadata = None`, migrations are hand-written DDL,
autogenerate is off by design. Introducing a Base for one of ~15 live tables
would also arm a footgun: the first person to wire `target_metadata` would get
an autogenerate diff proposing to drop every unmapped table.

The table itself already exists (migrations/generation/versions/
0001_generation_baseline.py). Nothing here migrates it.
"""
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID

from sqlalchemy import RowMapping

JOBS_TABLE = "generation.jobs"


class JobStatus(StrEnum):
    """Mirrors the jobs_status_vals CHECK constraint."""

    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    DEAD_LETTERED = "DEAD_LETTERED"


# A job in one of these has finished for good. finalize_job refuses to
# transition out of them, so a duplicate SNS delivery cannot double-publish.
TERMINAL_STATUSES: frozenset[str] = frozenset(
    {JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.DEAD_LETTERED}
)

# Mirrors the jobs_kind_vals CHECK constraint.
JobKind = Literal["generate", "variation", "refine_fresh", "refine_audio"]
JOB_KINDS: frozenset[str] = frozenset(
    {"generate", "variation", "refine_fresh", "refine_audio"}
)


@dataclass(frozen=True, slots=True)
class JobRow:
    """One row of generation.jobs, typed."""

    id: UUID
    user_id: UUID
    kind: str
    status: str
    parent_track_id: UUID | None
    worker_id: str | None
    attempt: int
    s3_wav_key: str | None
    s3_mp3_key: str | None
    duration_seconds: int | None
    waveform_hash: str | None
    error: str | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None

    @classmethod
    def from_row(cls, row: RowMapping) -> "JobRow":
        return cls(
            id=row["id"],
            user_id=row["user_id"],
            kind=row["kind"],
            status=row["status"],
            parent_track_id=row["parent_track_id"],
            worker_id=row["worker_id"],
            attempt=row["attempt"],
            s3_wav_key=row["s3_wav_key"],
            s3_mp3_key=row["s3_mp3_key"],
            duration_seconds=row["duration_seconds"],
            waveform_hash=row["waveform_hash"],
            error=row["error"],
            created_at=row["created_at"],
            started_at=row["started_at"],
            completed_at=row["completed_at"],
        )


@dataclass(frozen=True, slots=True)
class JobStatusRow:
    """
    The owner-scoped status projection behind GET /jobs/{job_id}.

    Narrower than JobRow on purpose: this is polled every 5s by any client whose
    SSE stream died, so it selects only what that client needs to decide whether
    to keep waiting.
    """

    id: UUID
    status: str
    kind: str
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    error: str | None
    s3_mp3_key: str | None
    track_id: UUID | None

    @classmethod
    def from_row(cls, row: RowMapping) -> "JobStatusRow":
        return cls(
            id=row["id"],
            status=row["status"],
            kind=row["kind"],
            created_at=row["created_at"],
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            error=row["error"],
            s3_mp3_key=row["s3_mp3_key"],
            track_id=row["track_id"],
        )


# Column list shared by the SELECTs in service.py — keeps them in sync with
# JobRow.from_row above.
JOB_COLUMNS = (
    "id, user_id, kind, status, parent_track_id, worker_id, attempt, "
    "s3_wav_key, s3_mp3_key, duration_seconds, waveform_hash, error, "
    "created_at, started_at, completed_at"
)
