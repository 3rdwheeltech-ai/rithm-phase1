"""catalog grants for rithm_generation + unique index on tracks.source_job_id

Day 2 makes job completion atomic: generation's finalize_job writes
generation.jobs, catalog.tracks and catalog.prompt_history in ONE transaction,
on the generation connection. That connection authenticates as rithm_generation,
which by default has USAGE on the generation schema only (ops/db/00_init.sql),
so it needs a narrow cross-schema grant to insert the track.

Deliberately minimal: USAGE on the schema, INSERT on exactly two tables, and
COLUMN-level SELECT on tracks.(id, source_job_id) only. No table-level SELECT
(generation never reads track content), no other tables, no sequences — primary
keys are app-side uuid7(). The FK check on prompt_history -> tracks runs as the
table owner, so INSERT alone is sufficient there.

Those two columns of SELECT are not optional and are easy to get wrong:

  source_job_id  Postgres evaluates an ON CONFLICT inference specification by
                 probing the arbiter index, which needs SELECT on the inferred
                 column. INSERT alone fails the whole statement with
                 "permission denied for table tracks".
  id             on a replayed completion the insert does nothing, and the
                 service reads back the existing track's id so it can still
                 return one to the SSE event.

Both are identifiers, not content. Verified against Postgres 16: table-level
SELECT stays revoked, so `SELECT prompt FROM catalog.tracks` is still denied to
rithm_generation. tests/test_catalog_live.py pins both halves.

The unique index is what ON CONFLICT (source_job_id) DO NOTHING infers against;
without it that clause raises at runtime. The primary idempotency guard is
finalize_job's terminal-status WHERE clause — this is defence in depth for the
case where two SNS deliveries race.

MUST be applied by a role that can GRANT (rithm_admin locally, rithm_master on
RDS). The module roles cannot apply it themselves.

Revision ID: 0002_catalog_generation_grants
Revises: 0001_catalog_baseline
Create Date: 2026-08-01

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002_catalog_generation_grants"
down_revision: str | Sequence[str] | None = "0001_catalog_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        -- Backstop for catalog/service.py's ON CONFLICT (source_job_id).
        -- Created before the grants so a duplicate-row failure surfaces here,
        -- during migration, rather than on the first replayed completion.
        CREATE UNIQUE INDEX IF NOT EXISTS tracks_source_job_uidx
            ON catalog.tracks (source_job_id);

        GRANT USAGE  ON SCHEMA catalog                          TO rithm_generation;
        GRANT INSERT ON catalog.tracks, catalog.prompt_history  TO rithm_generation;

        -- Column-scoped, NOT table-level: required for the ON CONFLICT arbiter
        -- probe above, and nothing more. Track content stays unreadable.
        GRANT SELECT (id, source_job_id) ON catalog.tracks       TO rithm_generation;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        REVOKE SELECT (id, source_job_id) ON catalog.tracks     FROM rithm_generation;
        REVOKE INSERT ON catalog.tracks, catalog.prompt_history FROM rithm_generation;
        REVOKE USAGE  ON SCHEMA catalog                          FROM rithm_generation;

        DROP INDEX IF EXISTS catalog.tracks_source_job_uidx;
        """
    )
