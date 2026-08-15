"""identity.users.profile — one JSONB document per user

Holds the display name and the music preferences collected at onboarding.
Deliberately a single document rather than a column per field: adding a
preference later is a Pydantic/TypeScript change, not a migration.

The shape is owned by app/modules/identity/models.py (PROFILE_VERSION), NOT by
this DDL — Postgres only guarantees it is valid JSON. `'{}'` is a legal value
and means "never asked"; the read path normalizes it into a full document.

ADD COLUMN with a non-volatile DEFAULT is metadata-only on PG 11+, so this does
not rewrite the table and is safe to run against RDS from the deploy pipeline's
pre-swap migration task.

Revision ID: 0002_identity_user_profile
Revises: 0001_identity_baseline
Create Date: 2026-08-15

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002_identity_user_profile"
down_revision: str | Sequence[str] | None = "0001_identity_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # IF NOT EXISTS because ops/db/01_identity.sql carries the same column for
    # the fresh-bootstrap path (docker-compose initdb, rds-bootstrap.sql) and
    # that file may or may not have run first depending on the environment —
    # CI runs 00_init.sql only and lets Alembic build every table.
    op.execute(
        """
        ALTER TABLE identity.users
            ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}'::jsonb;
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE identity.users DROP COLUMN IF EXISTS profile;")
