-- ─────────────────────────────────────────────────────────────────────────────
-- 04_conversation.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE conversation.sessions (
    id              UUID         PRIMARY KEY,
    user_id         UUID         NOT NULL,
    current_state   VARCHAR(20)  NOT NULL DEFAULT 'DESCRIBING',
    active_track_id UUID,                                   -- track currently being discussed/refined
    voice_enabled   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,

    CONSTRAINT sessions_state_vals CHECK (current_state IN
        ('DESCRIBING','AWAITING_GEN','REFINING','READY_TO_EXPORT'))
);

CREATE INDEX sessions_user_updated_idx
    ON conversation.sessions (user_id, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE TRIGGER sessions_touch
    BEFORE UPDATE ON conversation.sessions
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE conversation.messages (
    id            UUID         PRIMARY KEY,
    session_id    UUID         NOT NULL REFERENCES conversation.sessions(id) ON DELETE CASCADE,
    role          VARCHAR(16)  NOT NULL,
    content       TEXT         NOT NULL,
    tool_calls    JSONB,                                    -- Bedrock tool_use blocks
    audio_s3_key  VARCHAR(512),                             -- voice turns: input audio or TTS output
    token_count   INT,                                      -- estimate, used for history truncation
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT messages_role_vals CHECK (role IN ('user','assistant','system'))
);

CREATE INDEX messages_session_created_idx
    ON conversation.messages (session_id, created_at ASC);
