"""
The claim — the worker's only database write, and the single source of truth
for idempotency.

Two rules make the rest of the pipeline safe to reason about:

1. The claim runs in its OWN committed transaction and the connection is
   released before inference starts. The worker holds no DB connection across a
   multi-minute GPU call, so a pool of one is enough and a stalled job cannot
   pin a backend.
2. The worker never writes COMPLETED or FAILED. Terminal transitions belong to
   the API's finalize_job, driven by the SNS callback, because that is where the
   catalog write has to join the same transaction.

Crash semantics fall out of (1) and are both correct: a crash after the commit
leaves the row RUNNING for the Day-3 sweeper to fail; a crash before it leaves
the row QUEUED and SQS redelivers.
"""

import structlog
from sqlalchemy import Engine, create_engine, text

from worker.config import get_settings

logger = structlog.get_logger()

_engine: Engine | None = None


def get_engine() -> Engine:
    """
    Lazily build the sync engine.

    pool_pre_ping is not optional here: the worker long-polls for 20s at a time
    and may idle for minutes between jobs, which is exactly long enough for a
    connection to be reaped server-side. Without it the first query after an
    idle stretch fails with a stale-connection error.
    """
    global _engine
    if _engine is None:
        _engine = create_engine(
            get_settings().db_generation_dsn_sync.get_secret_value(),
            pool_pre_ping=True,
            pool_size=1,
            max_overflow=1,
            future=True,
        )
    return _engine


def reset_engine() -> None:
    """Drop the cached engine. Test helper — not used at runtime."""
    global _engine
    if _engine is not None:
        _engine.dispose()
    _engine = None


def claim_job(job_id: str, worker_id: str) -> bool:
    """
    Atomic QUEUED→RUNNING claim.

    True  = we own this job, proceed.
    False = someone else already claimed or finished it. NOT an error — the
            caller deletes the message and drops it silently.

    The guard is `WHERE status='QUEUED'`, so a redelivered message for a job
    already RUNNING/COMPLETED matches zero rows. That is the worker half of
    Gate C6; finalize_job's terminal-status guard is the API half.
    """
    with get_engine().begin() as conn:
        row = conn.execute(
            text(
                """
                UPDATE generation.jobs
                   SET status     = 'RUNNING',
                       started_at = now(),
                       worker_id  = :worker_id,
                       attempt    = attempt + 1
                 WHERE id = :job_id
                   AND status = 'QUEUED'
                RETURNING id
                """
            ),
            {"job_id": job_id, "worker_id": worker_id},
        ).first()
    return row is not None
