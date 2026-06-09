-- ─────────────────────────────────────────────────────────────────────────────
-- 03_generation.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE generation.jobs (
    id                 UUID         PRIMARY KEY,
    user_id            UUID         NOT NULL,               -- logical FK → identity.users.id
    kind               VARCHAR(16)  NOT NULL,
    status             VARCHAR(16)  NOT NULL DEFAULT 'QUEUED',
    request_payload    JSONB        NOT NULL,
    parent_track_id    UUID,                                -- non-null for variation/refine
    worker_id          VARCHAR(128),                        -- ECS task ARN of claimant
    attempt            SMALLINT     NOT NULL DEFAULT 0,

    -- Outputs (populated on COMPLETED)
    s3_wav_key         VARCHAR(512),
    s3_mp3_key         VARCHAR(512),
    duration_seconds   INT,
    waveform_hash      CHAR(64),
    error              TEXT,

    -- Timing
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,

    CONSTRAINT jobs_kind_vals   CHECK (kind   IN ('generate','variation','refine_fresh','refine_audio')),
    CONSTRAINT jobs_status_vals CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','DEAD_LETTERED'))
);

-- Rate-limit query: rolling 24h window per user
CREATE INDEX jobs_user_created_idx
    ON generation.jobs (user_id, created_at DESC);

-- Operational monitoring: queued/running jobs across all users
CREATE INDEX jobs_status_active_idx
    ON generation.jobs (status)
    WHERE status IN ('QUEUED','RUNNING');
