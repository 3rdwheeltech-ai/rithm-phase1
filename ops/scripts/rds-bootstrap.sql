-- ─────────────────────────────────────────────────────────────────────────────
-- rds-bootstrap.sql
-- Run ONCE against RDS as the master user (rithm_master). Mirrors ops/db/00_init.sql
-- (the local docker-entrypoint-initdb.d bootstrap) but takes per-module passwords as
-- psql variables so NO secrets are written into this file.
--
-- Usage (all five passwords passed via -v, values held in your shell env):
--   PGPASSWORD="$MASTER_PW" psql \
--     "host=$RDS_HOST port=5432 dbname=$DB_NAME user=$MASTER_USER sslmode=require" \
--     -v ON_ERROR_STOP=1 \
--     -v rithm_identity_pw="$RITHM_IDENTITY_PW" \
--     -v rithm_catalog_pw="$RITHM_CATALOG_PW" \
--     -v rithm_generation_pw="$RITHM_GENERATION_PW" \
--     -v rithm_conversation_pw="$RITHM_CONVERSATION_PW" \
--     -v rithm_personalization_pw="$RITHM_PERSONALIZATION_PW" \
--     -f ops/scripts/rds-bootstrap.sql
--
-- Note: psql does NOT substitute :'vars' inside dollar-quoted DO blocks, so roles are
-- created with explicit per-module statements (unlike the array-loop in 00_init.sql).
-- Tables are created later by Alembic migrations running as this same master user;
-- ALTER DEFAULT PRIVILEGES below grants those future tables to each module role.
-- ─────────────────────────────────────────────────────────────────────────────

-- Extensions (both on RDS's supported-extensions list; master may create them)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- reserved for Phase 2 full-text search

-- Shared updated_at trigger function used by all modules.
-- Must exist before any table trigger references it (migrations assume it exists).
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION public.touch_updated_at() TO PUBLIC;

-- Schemas — one per bounded-context module
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS generation;
CREATE SCHEMA IF NOT EXISTS conversation;
CREATE SCHEMA IF NOT EXISTS personalization;

-- ── identity ────────────────────────────────────────────────────────────────
CREATE ROLE rithm_identity LOGIN PASSWORD :'rithm_identity_pw';
GRANT USAGE ON SCHEMA identity TO rithm_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA identity TO rithm_identity;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA identity TO rithm_identity;
ALTER DEFAULT PRIVILEGES IN SCHEMA identity GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO rithm_identity;
ALTER DEFAULT PRIVILEGES IN SCHEMA identity GRANT USAGE, SELECT                  ON SEQUENCES TO rithm_identity;

-- ── catalog ─────────────────────────────────────────────────────────────────
CREATE ROLE rithm_catalog LOGIN PASSWORD :'rithm_catalog_pw';
GRANT USAGE ON SCHEMA catalog TO rithm_catalog;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA catalog TO rithm_catalog;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA catalog TO rithm_catalog;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO rithm_catalog;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog GRANT USAGE, SELECT                  ON SEQUENCES TO rithm_catalog;

-- ── generation ──────────────────────────────────────────────────────────────
CREATE ROLE rithm_generation LOGIN PASSWORD :'rithm_generation_pw';
GRANT USAGE ON SCHEMA generation TO rithm_generation;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA generation TO rithm_generation;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA generation TO rithm_generation;
ALTER DEFAULT PRIVILEGES IN SCHEMA generation GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO rithm_generation;
ALTER DEFAULT PRIVILEGES IN SCHEMA generation GRANT USAGE, SELECT                  ON SEQUENCES TO rithm_generation;

-- ── conversation ────────────────────────────────────────────────────────────
CREATE ROLE rithm_conversation LOGIN PASSWORD :'rithm_conversation_pw';
GRANT USAGE ON SCHEMA conversation TO rithm_conversation;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA conversation TO rithm_conversation;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA conversation TO rithm_conversation;
ALTER DEFAULT PRIVILEGES IN SCHEMA conversation GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO rithm_conversation;
ALTER DEFAULT PRIVILEGES IN SCHEMA conversation GRANT USAGE, SELECT                  ON SEQUENCES TO rithm_conversation;

-- ── personalization ─────────────────────────────────────────────────────────
CREATE ROLE rithm_personalization LOGIN PASSWORD :'rithm_personalization_pw';
GRANT USAGE ON SCHEMA personalization TO rithm_personalization;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA personalization TO rithm_personalization;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA personalization TO rithm_personalization;
ALTER DEFAULT PRIVILEGES IN SCHEMA personalization GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO rithm_personalization;
ALTER DEFAULT PRIVILEGES IN SCHEMA personalization GRANT USAGE, SELECT                  ON SEQUENCES TO rithm_personalization;
