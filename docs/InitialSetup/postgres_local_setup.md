# SPEC: Section B — Local Postgres Setup (Complete)
**Project:** RITHM  
**Scope:** docker-compose Postgres service + all 6 DDL files (`ops/db/00_init.sql` → `05_personalization.sql`) + bring-up and verification.  
**catalog.tracks includes all 4 pending changes** (lyrics, ref_audio_s3_key, inference_steps, genre/mood constraints commented out).

---

## Repo context

```
<repo-root>/
├── docker-compose.yml          ← create or merge here
├── ops/
│   ├── db/                     ← CREATE this directory; all DDL files go here
│   │   ├── 00_init.sql
│   │   ├── 01_identity.sql
│   │   ├── 02_catalog.sql
│   │   ├── 03_generation.sql
│   │   ├── 04_conversation.sql
│   │   └── 05_personalization.sql
│   └── scripts/
│       ├── init-db-users.sql   ← EXISTING file; leave untouched
│       └── init-localstack.sh  ← EXISTING file; leave untouched
```

`ops/scripts/init-db-users.sql` already exists but is NOT mounted by the docker-compose
service below — it is a Phase0 skeleton/reference, not the active init path.  
`ops/db/` is the mounted path; `00_init.sql` supersedes it for runtime use.

**If a `docker-compose.yml` already exists at the repo root**, merge the `postgres`
service and `rithm_pgdata` volume into it instead of replacing the file.

---

## File 1: `docker-compose.yml` (repo root)

```yaml
services:
  postgres:
    image: postgres:16
    container_name: rithm-postgres
    environment:
      POSTGRES_USER: rithm_admin
      POSTGRES_PASSWORD: dev_admin_pw
      POSTGRES_DB: rithm
    ports:
      - "5432:5432"
    volumes:
      - rithm_pgdata:/var/lib/postgresql/data
      - ./ops/db:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rithm_admin -d rithm"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  rithm_pgdata:
```

**How init works:** on first start, Postgres runs every `*.sql` file in
`/docker-entrypoint-initdb.d` (i.e. `ops/db/`) in **alphabetical order** as
`rithm_admin` against the `rithm` database. Files only run on an empty data volume.
To re-run: `docker compose down -v && docker compose up -d --wait`.

---

## File 2: `ops/db/00_init.sql`

Extensions, shared trigger function, schemas, and per-module login roles with grants.
Must run before all other files (hence `00_` prefix).

```sql
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
```

---

## File 3: `ops/db/01_identity.sql`

```sql
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
```

---

## File 4: `ops/db/02_catalog.sql`

Includes all four pending DDL changes:
- `lyrics TEXT` added (nullable)
- `ref_audio_s3_key VARCHAR(512)` added (nullable)
- `inference_steps INT NOT NULL DEFAULT 60` added
- `tracks_genre_vals` and `tracks_mood_vals` CHECK constraints commented out

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- 02_catalog.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE catalog.tracks (
    id               UUID         PRIMARY KEY,
    user_id          UUID         NOT NULL,                  -- logical FK → identity.users.id
    source_job_id    UUID         NOT NULL,                  -- logical FK → generation.jobs.id

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
    -- Re-enable below if enum enforcement is required in a future phase.
    -- ,CONSTRAINT tracks_genre_vals CHECK (genre IS NULL OR genre IN (
    --     'Pop','Hip-Hop','EDM','Lo-Fi','Cinematic','Rock','Country','R&B','Ambient'))
    -- ,CONSTRAINT tracks_mood_vals  CHECK (mood IS NULL OR mood IN (
    --     'Happy','Calm','Energetic','Dark','Romantic','Inspirational','Dramatic'))
);

CREATE INDEX tracks_user_created_idx
    ON catalog.tracks (user_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX tracks_user_genre_idx
    ON catalog.tracks (user_id, genre)
    WHERE deleted_at IS NULL;

CREATE TRIGGER tracks_touch
    BEFORE UPDATE ON catalog.tracks
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE catalog.prompt_history (
    id             UUID         PRIMARY KEY,
    track_id       UUID         NOT NULL REFERENCES catalog.tracks(id) ON DELETE CASCADE,
    prompt         TEXT         NOT NULL,
    delta_command  TEXT,                                     -- NULL for initial; set for refinements
    kind           VARCHAR(16)  NOT NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT prompt_kind_vals CHECK (kind IN
        ('initial','refine_fresh','refine_audio','remix','variation'))
);

CREATE INDEX prompt_history_track_created_idx
    ON catalog.prompt_history (track_id, created_at ASC);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE catalog.feedback (
    id          UUID         PRIMARY KEY,
    track_id    UUID         NOT NULL REFERENCES catalog.tracks(id) ON DELETE CASCADE,
    user_id     UUID         NOT NULL,
    rating      SMALLINT     NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT feedback_rating_vals     CHECK (rating IN (-1, 1)),
    CONSTRAINT feedback_unique_per_user UNIQUE (track_id, user_id)
);
-- Upsert pattern: INSERT ... ON CONFLICT (track_id, user_id) DO UPDATE SET rating = EXCLUDED.rating
```

---

## File 5: `ops/db/03_generation.sql`

```sql
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
```

---

## File 6: `ops/db/04_conversation.sql`

```sql
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
```

---

## File 7: `ops/db/05_personalization.sql`

```sql
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
```

---

## Bring It Up

Run from the **repo root**:

```bash
docker compose up -d --wait
```

Expected output: `rithm-postgres` reaches `healthy` status. If it exits immediately,
run `docker compose logs postgres` to see SQL errors from the init scripts.

---

## Verification

Run each block in order. All should pass before marking Section B complete.

```bash
# ── 1. Container is healthy ───────────────────────────────────────────────────
docker compose ps
# rithm-postgres   Up   (healthy)

# ── 2. Five schemas exist ─────────────────────────────────────────────────────
docker compose exec postgres psql -U rithm_admin -d rithm -c "\dn"
# Expected: identity, catalog, generation, conversation, personalization
# (plus public)

# ── 3. All tables exist ───────────────────────────────────────────────────────
docker compose exec postgres psql -U rithm_admin -d rithm -c "
SELECT schemaname, tablename
FROM pg_tables
WHERE schemaname IN ('identity','catalog','generation','conversation','personalization')
ORDER BY schemaname, tablename;
"
# Expected 8 rows:
#   catalog       | feedback
#   catalog       | prompt_history
#   catalog       | tracks
#   conversation  | messages
#   conversation  | sessions
#   generation    | jobs
#   identity      | users
#   personalization | activity_events

# ── 4. Per-module role isolation ──────────────────────────────────────────────
# rithm_identity can read its own schema:
docker compose exec postgres psql -U rithm_identity -d rithm \
  -c "SELECT count(*) FROM identity.users;"
# Expected: 0 (empty table, no error)

# rithm_identity cannot touch another schema:
docker compose exec postgres psql -U rithm_identity -d rithm \
  -c "SELECT count(*) FROM catalog.tracks;" 2>&1 | grep -i "permission denied"
# Expected: line containing "permission denied"

# ── 5. catalog.tracks — DDL change verification ───────────────────────────────
# New columns present:
docker compose exec postgres psql -U rithm_admin -d rithm -c "
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'catalog' AND table_name = 'tracks'
ORDER BY ordinal_position;
"
# Must include:
#   inference_steps  | integer           | NO  | 60
#   lyrics           | text              | YES | (null)
#   ref_audio_s3_key | character varying | YES | (null)

# Genre/mood constraints are gone:
docker compose exec postgres psql -U rithm_admin -d rithm -c "
SELECT conname FROM pg_constraint
WHERE conrelid = 'catalog.tracks'::regclass
  AND conname IN ('tracks_genre_vals','tracks_mood_vals');
"
# Expected: 0 rows

# Remaining constraints still present:
docker compose exec postgres psql -U rithm_admin -d rithm -c "
SELECT conname, contype FROM pg_constraint
WHERE conrelid = 'catalog.tracks'::regclass
ORDER BY conname;
"
# Expected: tracks_bpm_range (c), tracks_length_range (c)

# ── 6. Smoke test — open-ended genre/mood accepted ────────────────────────────
docker compose exec postgres psql -U rithm_admin -d rithm -c "
INSERT INTO catalog.tracks (
    id, user_id, source_job_id,
    genre, mood, vocal, length_seconds,
    prompt, s3_wav_key, s3_mp3_key, waveform_hash
) VALUES (
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    'Afrobeats', 'Nostalgic',
    true, 60,
    '_smoke_test_', '_smoke_/wav', '_smoke_/mp3', repeat('a', 64)
);
"
# Expected: INSERT 0 1  (no constraint violation — old constraints would have rejected 'Afrobeats')

# Cleanup:
docker compose exec postgres psql -U rithm_admin -d rithm -c "
DELETE FROM catalog.tracks WHERE prompt = '_smoke_test_';
"

# ── 7. Trigger fires on update ────────────────────────────────────────────────
docker compose exec postgres psql -U rithm_admin -d rithm -c "
DO \$\$
DECLARE
  uid UUID := gen_random_uuid();
  t1 TIMESTAMPTZ; t2 TIMESTAMPTZ;
BEGIN
  INSERT INTO identity.users (id, cognito_sub, email)
  VALUES (uid, 'smoke-sub-' || uid, 'smoke@example.com');

  SELECT updated_at INTO t1 FROM identity.users WHERE id = uid;
  PERFORM pg_sleep(0.01);
  UPDATE identity.users SET email_verified = true WHERE id = uid;
  SELECT updated_at INTO t2 FROM identity.users WHERE id = uid;

  IF t2 <= t1 THEN RAISE EXCEPTION 'touch_updated_at trigger did not fire'; END IF;
  DELETE FROM identity.users WHERE id = uid;
  RAISE NOTICE 'Trigger OK: updated_at advanced from % to %', t1, t2;
END;
\$\$;
"
# Expected: NOTICE: Trigger OK: updated_at advanced from ... to ...
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Container exits immediately | SQL error in an init script | `docker compose logs postgres` → find the failing file → fix SQL → `docker compose down -v && docker compose up -d --wait` |
| `role "rithm_identity" already exists` | Volume not wiped before re-run | `docker compose down -v` (destroys data) then re-up |
| `permission denied for schema catalog` when expected | Default privileges didn't apply | Check that `00_init.sql` ran before `02_catalog.sql`; file naming `00_` vs `02_` controls order |
| Smoke test INSERT fails on genre/mood | Old constraint still present | The volume has stale schema — `docker compose down -v` and re-up to re-run init scripts |
| Port 5432 already in use | Another Postgres is running locally | `lsof -i :5432` to find it; stop it or change the host port in docker-compose to `5433:5432` and update DSNs accordingly |