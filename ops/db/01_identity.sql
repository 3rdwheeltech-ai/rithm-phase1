-- ─────────────────────────────────────────────────────────────────────────────
-- 01_identity.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE identity.users (
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

CREATE TRIGGER users_touch
    BEFORE UPDATE ON identity.users
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
