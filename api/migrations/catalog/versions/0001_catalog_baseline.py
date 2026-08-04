"""catalog baseline — catalog.tracks, catalog.prompt_history, catalog.feedback

Transcribed from ops/db/02_catalog.sql (as-built local schema; includes
inference_steps/lyrics/ref_audio_s3_key and the genre/mood CHECKs removed).
Assumes the 'catalog' schema and public.touch_updated_at() already exist.

Revision ID: 0001_catalog_baseline
Revises:
Create Date: 2026-07-14

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001_catalog_baseline"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS catalog.tracks (
            id               UUID         PRIMARY KEY,
            user_id          UUID         NOT NULL,                  -- logical FK -> identity.users.id
            source_job_id    UUID         NOT NULL,                  -- logical FK -> generation.jobs.id

            -- Generation inputs (denormalized for query convenience)
            genre            VARCHAR(32),
            mood             VARCHAR(32),
            bpm              INT,
            vocal            BOOLEAN      NOT NULL DEFAULT TRUE,
            length_seconds   INT          NOT NULL,
            inference_steps  INT          NOT NULL DEFAULT 60,       -- ACE-Step inference steps; stored for reproducibility

            -- Content
            prompt           TEXT         NOT NULL,
            lyrics           TEXT,                                   -- NULL for instrumental tracks
            params           JSONB        NOT NULL DEFAULT '{}'::jsonb,

            -- Reference audio input (optional; for audio-guided / refine_audio generation)
            ref_audio_s3_key VARCHAR(512),

            -- Output audio assets
            s3_wav_key       VARCHAR(512) NOT NULL,
            s3_mp3_key       VARCHAR(512) NOT NULL,
            waveform_hash    CHAR(64)     NOT NULL,                  -- SHA-256 hex of PCM samples

            -- Audit
            created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
            updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
            deleted_at       TIMESTAMPTZ,

            CONSTRAINT tracks_length_range CHECK (length_seconds BETWEEN 10 AND 180),
            CONSTRAINT tracks_bpm_range    CHECK (bpm IS NULL OR bpm BETWEEN 20 AND 300)
            -- Genre and mood constraints removed — values are open-ended.
        );

        CREATE INDEX IF NOT EXISTS tracks_user_created_idx
            ON catalog.tracks (user_id, created_at DESC)
            WHERE deleted_at IS NULL;

        CREATE INDEX IF NOT EXISTS tracks_user_genre_idx
            ON catalog.tracks (user_id, genre)
            WHERE deleted_at IS NULL;

        DROP TRIGGER IF EXISTS tracks_touch ON catalog.tracks;
        CREATE TRIGGER tracks_touch
            BEFORE UPDATE ON catalog.tracks
            FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

        CREATE TABLE IF NOT EXISTS catalog.prompt_history (
            id             UUID         PRIMARY KEY,
            track_id       UUID         NOT NULL REFERENCES catalog.tracks(id) ON DELETE CASCADE,
            prompt         TEXT         NOT NULL,
            delta_command  TEXT,                                     -- NULL for initial; set for refinements
            kind           VARCHAR(16)  NOT NULL,
            created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

            CONSTRAINT prompt_kind_vals CHECK (kind IN
                ('initial','refine_fresh','refine_audio','remix','variation'))
        );

        CREATE INDEX IF NOT EXISTS prompt_history_track_created_idx
            ON catalog.prompt_history (track_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS catalog.feedback (
            id          UUID         PRIMARY KEY,
            track_id    UUID         NOT NULL REFERENCES catalog.tracks(id) ON DELETE CASCADE,
            user_id     UUID         NOT NULL,
            rating      SMALLINT     NOT NULL,
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

            CONSTRAINT feedback_rating_vals     CHECK (rating IN (-1, 1)),
            CONSTRAINT feedback_unique_per_user UNIQUE (track_id, user_id)
        );
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE IF EXISTS catalog.feedback CASCADE;
        DROP TABLE IF EXISTS catalog.prompt_history CASCADE;
        DROP TABLE IF EXISTS catalog.tracks CASCADE;
        """
    )
