"""identity baseline — identity.users

Transcribed from ops/db/01_identity.sql (as-built local schema).
Assumes the 'identity' schema and public.touch_updated_at() already exist
(created by the bootstrap: ops/db/00_init.sql locally, rds-bootstrap.sql on RDS).

Revision ID: 0001_identity_baseline
Revises:
Create Date: 2026-07-14

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001_identity_baseline"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS identity.users (
            id                   UUID         NOT NULL PRIMARY KEY,
            cognito_sub          VARCHAR(64)  NOT NULL UNIQUE,
            email                VARCHAR(320) NOT NULL UNIQUE,      -- RFC 5321 max
            email_verified       BOOLEAN      NOT NULL DEFAULT TRUE, -- Phase 1: bypassed
            mfa_enabled          BOOLEAN      NOT NULL DEFAULT FALSE, -- Phase 2 hook
            is_admin             BOOLEAN      NOT NULL DEFAULT FALSE,
            consent_accepted_at  TIMESTAMPTZ,
            consent_version      VARCHAR(16),                        -- e.g. 'tos-2026-05'
            created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
            updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
        );

        DROP TRIGGER IF EXISTS users_touch ON identity.users;
        CREATE TRIGGER users_touch
            BEFORE UPDATE ON identity.users
            FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS identity.users CASCADE;")
