-- ─────────────────────────────────────────────────────────────────────────────
-- 00_init.sql
-- Extensions, shared trigger function, schemas, and per-module DB roles.
-- Runs first (alphabetical order). All subsequent files assume this has run.
-- DEV passwords only — never use these in production.
-- ─────────────────────────────────────────────────────────────────────────────

-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- reserved for Phase 2 full-text search

-- Shared updated_at trigger function used by all modules.
-- Must exist before any table references it.
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Explicit grant so per-module roles (created below) can execute this function.
GRANT EXECUTE ON FUNCTION public.touch_updated_at() TO PUBLIC;

-- Schemas — one per bounded-context module
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS generation;
CREATE SCHEMA IF NOT EXISTS conversation;
CREATE SCHEMA IF NOT EXISTS personalization;

-- Per-module login roles.
-- Each role has USAGE on its own schema only (enforcement of bounded-context isolation).
-- ALTER DEFAULT PRIVILEGES ensures tables created by rithm_admin in each schema
-- (i.e. files 01–05) are automatically granted to the relevant role.
DO $$
DECLARE
  modules   TEXT[] := ARRAY['identity','catalog','generation','conversation','personalization'];
  passwords TEXT[] := ARRAY['dev_identity_pw','dev_catalog_pw','dev_generation_pw',
                             'dev_conversation_pw','dev_personalization_pw'];
  i INT;
BEGIN
  FOR i IN 1..array_length(modules, 1) LOOP
    EXECUTE format('CREATE ROLE rithm_%s LOGIN PASSWORD %L', modules[i], passwords[i]);

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO rithm_%s', modules[i], modules[i]);

    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO rithm_%s',
      modules[i], modules[i]);

    EXECUTE format(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO rithm_%s',
      modules[i], modules[i]);

    -- Covers tables created AFTER this script (files 01–05):
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rithm_%s',
      modules[i], modules[i]);

    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO rithm_%s',
      modules[i], modules[i]);
  END LOOP;
END;
$$;
