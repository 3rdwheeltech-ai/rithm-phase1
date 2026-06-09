-- ─────────────────────────────────────────────────────────────────────────────
-- 05_personalization.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE personalization.activity_events (
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

CREATE INDEX events_user_type_created_idx
    ON personalization.activity_events (user_id, event_type, created_at DESC);

CREATE INDEX events_unprocessed_idx
    ON personalization.activity_events (created_at)
    WHERE processed_at IS NULL;
