-- Creates the touch_updated_at trigger function (used by all modules)
-- and per-module schemas + restricted users.
-- ⚠️  This file uses DEV passwords. NEVER commit real passwords here.
-- In prod: run this manually as rithm_admin with passwords from Secrets Manager.

-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Shared trigger function (must exist before module tables reference it)
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Schemas
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS generation;
CREATE SCHEMA IF NOT EXISTS conversation;
CREATE SCHEMA IF NOT EXISTS personalization;

-- Per-module users with schema-scoped grants
DO $$
DECLARE
  modules    TEXT[]  := ARRAY['identity','catalog','generation','conversation','personalization'];
  passwords  TEXT[]  := ARRAY['dev_identity_pw','dev_catalog_pw','dev_generation_pw','dev_conversation_pw','dev_personalization_pw'];
  i          INT;
BEGIN
  FOR i IN 1..array_length(modules,1) LOOP
    EXECUTE format(
      'CREATE ROLE rithm_%s LOGIN PASSWORD %L',
      modules[i], passwords[i]
    );
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO rithm_%s', modules[i], modules[i]);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO rithm_%s',
      modules[i], modules[i]
    );
    EXECUTE format(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO rithm_%s',
      modules[i], modules[i]
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rithm_%s',
      modules[i], modules[i]
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO rithm_%s',
      modules[i], modules[i]
    );
  END LOOP;
END;
$$;
