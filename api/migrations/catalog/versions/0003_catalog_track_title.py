"""catalog.tracks.title — a real name for a track

Until now every track in the app was named by a client-side regex over the
prompt (web/src/lib/track.ts). That is a display heuristic, not a name: it
cannot round-trip, two clients can disagree about it, and nothing the user
types can influence it. This column is the name.

A COLUMN, not a JSONB key in `params`. TRACK_COLUMNS deliberately excludes
`params` so list queries do not unpack JSONB per row
(catalog/models.py) — and every list row renders the title, so a JSONB title
would undo that on purpose.

NO RE-GRANT IS NEEDED, and this docstring is the place that says so.
0002_catalog_generation_grants gave rithm_generation TABLE-LEVEL
`INSERT ON catalog.tracks`; only the SELECT is column-scoped, to
(id, source_job_id). Postgres table-level INSERT covers columns added later.
The column-scoped GRANT SELECT sitting three lines above that INSERT in the
same migration is exactly the shape that invites someone to "fix" this with a
grant it does not need — don't. tests/test_catalog_live.py pins both halves:
generation can insert a row carrying a title, and still cannot SELECT one.

No index. Nothing sorts or filters on title, and tracks_user_created_idx
already covers the list query.

ADD COLUMN with no default and no NOT NULL is a catalog-only change and is
safe in both directions: the old API image simply never writes it.

Revision ID: 0003_catalog_track_title
Revises: 0002_catalog_generation_grants
Create Date: 2026-08-24

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003_catalog_track_title"
down_revision: str | Sequence[str] | None = "0002_catalog_generation_grants"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE catalog.tracks ADD COLUMN IF NOT EXISTS title VARCHAR(120);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE catalog.tracks DROP COLUMN IF EXISTS title;
        """
    )
