"""personalization baseline — personalization.activity_events

Transcribed from ops/db/05_personalization.sql (as-built local schema).
Assumes the 'personalization' schema already exists (no updated_at trigger).

Revision ID: 0001_personalization_baseline
Revises:
Create Date: 2026-07-14

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001_personalization_baseline"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS personalization.activity_events (
            id            UUID         PRIMARY KEY,
            user_id       UUID         NOT NULL,
            event_type    VARCHAR(20)  NOT NULL,
            entity_id     UUID,                                     -- track_id, job_id, etc. (context-dependent)
            metadata      JSONB        NOT NULL DEFAULT '{}'::jsonb,
            processed_at  TIMESTAMPTZ,                              -- Phase 2 marker; NULL throughout Phase 1
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

            CONSTRAINT events_type_vals CHECK (event_type IN (
                'generate','like','skip','download',
                'regenerate','variation','refine','play_complete'))
        );

        CREATE INDEX IF NOT EXISTS events_user_type_created_idx
            ON personalization.activity_events (user_id, event_type, created_at DESC);

        CREATE INDEX IF NOT EXISTS events_unprocessed_idx
            ON personalization.activity_events (created_at)
            WHERE processed_at IS NULL;
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS personalization.activity_events CASCADE;")
