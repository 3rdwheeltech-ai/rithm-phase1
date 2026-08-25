"""conversation.sessions.draft — what the chat has collected, and one session per user

Two statements, and the second one is the load-bearing half.

`draft JSONB` is where the conversation accumulates the SongDraft it is
building towards. JSONB rather than thirteen nullable columns: it is a partial
copy of a wire DTO that the SPA hands straight to the Create form, nothing
queries inside it, and every field in it is optional by definition.

`sessions_one_active_per_user` is NOT optional. `sessions_user_updated_idx` is
non-unique, so "resume the newest, create lazily on the first POST" forks the
transcript on two tabs, a double-click, or React StrictMode's double effect in
dev — and a forked transcript is invisible until someone notices the assistant
has forgotten the last three turns. With this index `start()` is
`INSERT … ON CONFLICT DO NOTHING` followed by a re-select, and the race resolves
in the database rather than in a comment. Partial on `deleted_at IS NULL` so
"start over" (a soft delete) leaves the old row in place and still allows a new
one.

NO RE-GRANT IS NEEDED, and this docstring is the place that says so.
ops/db/00_init.sql grants rithm_conversation TABLE-LEVEL
SELECT/INSERT/UPDATE/DELETE on every table in its schema, plus
ALTER DEFAULT PRIVILEGES for tables made later. Postgres table-level UPDATE
covers columns added afterwards. This is the same shape that made someone want
to "fix" 0003_catalog_track_title with a grant it did not need — don't.

`current_state` needs no CHECK change: the flow uses 'DESCRIBING' while it is
still collecting and 'READY_TO_EXPORT' once the draft is complete, and
sessions_state_vals already allows both.

Additive, nullable, and the index is partial, so a rollback to the previous API
image is safe: it simply never writes the column.

Revision ID: 0002_conversation_session_draft
Revises: 0001_conversation_baseline
Create Date: 2026-08-25

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002_conversation_session_draft"
down_revision: str | Sequence[str] | None = "0001_conversation_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE conversation.sessions ADD COLUMN IF NOT EXISTS draft JSONB;

        CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_active_per_user
            ON conversation.sessions (user_id) WHERE deleted_at IS NULL;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS conversation.sessions_one_active_per_user;
        ALTER TABLE conversation.sessions DROP COLUMN IF EXISTS draft;
        """
    )
