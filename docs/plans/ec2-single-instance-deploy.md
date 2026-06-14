# RITHM — Single-EC2 Deployment Plan (mirror the dev repo onto the ACE-Step box)

> **Goal:** Run the **entire `rithm-phase1` repo in its current state** on the same EC2 that already runs ACE-Step 1.5 (`:8001`) — web SPA + FastAPI `api` (Cognito auth) + `gen-proxy` + Postgres + LocalStack, all behind nginx, over HTTP for now (domain/TLS later). This is an exact mirror of the dev environment — **no new feature work**.
>
> **Status:** Plan only. Execute the steps in order on the EC2.

---

## 0. Why Cognito will NOT break (read this first)

Auth here is **backend-mediated**, not an OAuth/Hosted-UI redirect flow:

- The browser POSTs email/password to `/api/v1/auth/{signup,login,refresh}`.
- FastAPI calls Cognito via **boto3** — `sign_up`, `admin_set_user_password` (auto-confirm on signup), `initiate_auth` (`USER_PASSWORD_AUTH` / `REFRESH_TOKEN_AUTH`). See `api/app/modules/identity/service.py`.
- Protected requests carry `Authorization: Bearer <id_token>`; FastAPI validates the JWT against the **public** JWKS endpoint `https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json`. See `api/app/shared/auth.py`.
- The Cognito boto3 client is **hard-pinned to real AWS** (`identity/service.py:27`), so LocalStack never interferes.

**Consequences:**
1. **No Cognito console changes.** There are no callback/redirect URLs or allowed-origins tied to a hostname — moving to the EC2 changes nothing in the user pool.
2. **Cross-account is transparent.** boto3's credential chain uses **env-var creds first**, so we hand the API the *same IAM user creds already in dev `.env.local`* (an IAM user in the Cognito account). The EC2 living in a different AWS account is irrelevant. Only `admin_set_user_password` (signup) needs IAM perms; `initiate_auth` and JWKS validation are public.
3. **CORS is moot.** nginx serves the SPA and proxies `/api` + `/gen` on the same origin (port 80), so browser requests are same-origin — no preflight, no `Access-Control-*` dependency.

---

## 1. Target runtime topology

```
Browser ──HTTP:80──> nginx (host)
                       ├── /            -> /opt/rithm-phase1/web/dist   (static SPA + fallback)
                       ├── /api/        -> 127.0.0.1:8080               (api container, prefix kept)
                       └── /gen/        -> 127.0.0.1:8090               (gen-proxy container, /gen stripped)

docker compose (ports published on 127.0.0.1 ONLY — nginx is the only public listener):
   postgres:16   127.0.0.1:5432   first boot auto-runs ops/db/*.sql  -> schemas/roles/tables
   localstack:3  127.0.0.1:4566   first boot auto-runs ops/scripts/init-localstack.sh (SQS/SNS/S3)
   api           127.0.0.1:8080   -> Cognito (real AWS, outbound 443) + postgres + localstack
   gen-proxy     127.0.0.1:8090   -> host.docker.internal:8001  (ACE-Step on the host)

ACE-Step (native on host, :8001)  — already running; lock to localhost.
worker/  — NOT deployed (empty GPU stub; not in compose). Repo stays as-is.
```

All browser traffic is same-origin through nginx:80. ACE-Step is never exposed to the browser.

### Verified facts the topology relies on
- Web uses **relative** paths: `web/src/lib/api.ts` → `/api/...`; `web/src/services/musicgen.ts` → `/gen/generate`. No base URL is prepended; `VITE_*` env vars are unused at runtime (Amplify is not wired). → **web build needs no env.**
- gen-proxy returns **relative** audio URLs `/gen/audio?path=...` (`gen-proxy/src/acestep.ts:76`) and listens on `0.0.0.0:8090` (`src/server.ts:50`).
- The Vite dev proxy strips `/gen` but keeps `/api` (`web/vite.config.ts`). nginx must replicate exactly: strip `/gen`, keep `/api`.
- `docker-compose.yml` `api` service already injects the five `DB_*_DSN`s (→ `postgres:5432`), `AWS_ENDPOINT_URL=http://localstack:4566`, and reads `.env.local`.

---

## 2. Repo changes (additive only — no app logic touched)

Commit these to the deploy branch (`ckpt-1-sync-worker-demo`) so the EC2 just pulls them.

### 2a. New file — `gen-proxy/Dockerfile`
`gen-proxy` is the only service without a Dockerfile. `package.json` already defines `start: tsx src/server.ts`.

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 8090
CMD ["npm", "start"]
```

### 2b. New file — `docker-compose.ec2.yml` (override; leaves dev `docker-compose.yml` untouched)
Run with: `docker compose -f docker-compose.yml -f docker-compose.ec2.yml up -d --build`

```yaml
services:
  postgres:
    ports: ["127.0.0.1:5432:5432"]      # was 5433:5432; bind to loopback only

  localstack:
    ports: ["127.0.0.1:4566:4566"]

  api:
    ports: ["127.0.0.1:8080:8080"]      # loopback only — nginx fronts it

  gen-proxy:
    build: ./gen-proxy
    restart: unless-stopped
    ports: ["127.0.0.1:8090:8090"]
    env_file: [gen-proxy/.env]
    extra_hosts: ["host.docker.internal:host-gateway"]   # reach ACE-Step on the host
```

> Note: the dev compose maps Postgres to host `5433`. The override re-publishes loopback ports; the **internal** container port stays `5432`, which is what the `DB_*_DSN`s (`@postgres:5432`) use. Host port binding does not affect container-to-container networking.

### 2c. New file — `ops/db/06_generation_history.sql` (durable generation history table)
The Postgres container runs every `ops/db/*.sql` file **alphabetically on first boot**, inside the same init that already creates the schemas, the `rithm_*` roles, and `identity.users`. Adding this file (sorts after `05_*`) provisions the demo-friendly history table; `00_init.sql`'s `ALTER DEFAULT PRIVILEGES` auto-grants it to `rithm_generation`.

```sql
-- ops/db/06_generation_history.sql
-- Lightweight, demo-path generation history (gen-proxy flow — no S3/worker artifacts).
-- Owner key is the Cognito sub (from the validated id_token) to avoid a cross-schema
-- lookup into identity.users (bounded-context isolation: rithm_generation can't read identity).
CREATE TABLE generation.history (
    id               UUID         PRIMARY KEY,
    cognito_sub      VARCHAR(64)  NOT NULL,            -- owner; from the id_token claims
    title            VARCHAR(200),
    prompt           TEXT         NOT NULL DEFAULT '',
    lyrics           TEXT,                             -- newline-joined; split to array on read
    audio_url        TEXT         NOT NULL,            -- relative '/gen/audio?path=...'
    seed             VARCHAR(64),
    duration_seconds INT,
    liked            BOOLEAN      NOT NULL DEFAULT FALSE,
    params           JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- original GenerateParams
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX history_sub_created_idx
    ON generation.history (cognito_sub, created_at DESC);

CREATE TRIGGER history_touch
    BEFORE UPDATE ON generation.history
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
```

**DB scope for this deploy:** the existing `ops/db/00–05` plus this new `06` all run automatically — no manual SQL. Auth works via `00_init.sql` (schemas + `rithm_*` roles, **required** or the API can't connect) + `01_identity.sql` (`identity.users`). The `02–05` tables are unused by the demo but harmless. The only **new** artifact is `06_generation_history.sql`.

> The full generation-history feature (API + frontend wiring) is specified in **§10** and is **deferred** — not part of the initial bring-up. The table can be created now (harmless, empty) so the schema is ready when §10 is implemented.

---

## 3. Env files on the EC2 (gitignored — create by hand, like dev)

### 3a. `/opt/rithm-phase1/.env.local`  (root — consumed by the `api` service)
Copy **verbatim from the dev machine's `.env.local`**. The values that matter for auth:
```
COGNITO_USER_POOL_ID=<from dev>
COGNITO_APP_CLIENT_ID=<from dev>
COGNITO_APP_CLIENT_SECRET=<from dev>
AWS_DEFAULT_REGION=us-east-1
AWS_ACCESS_KEY_ID=<Cognito-account IAM user, from dev>
AWS_SECRET_ACCESS_KEY=<Cognito-account IAM user, from dev>
```
The `DB_*_DSN` and `ASSETS_BUCKET`/`SQS_*`/`SNS_*` values are overridden by compose (LocalStack), so dev placeholders are fine. `SSE_TOKEN_SECRET`, `CURRENT_CONSENT_VERSION` etc. copy as-is.

### 3b. `/opt/rithm-phase1/gen-proxy/.env`
Copy from dev, but change the upstream to the host:
```
ACESTEP_API_BASE=http://host.docker.internal:8001
PORT=8090
AUDIO_FORMAT=mp3
DEFAULT_MODEL=acestep-v15-turbo
THINKING=true          # set false if the EC2 has no 5Hz LM loaded
INFERENCE_STEPS=8
BATCH_SIZE=1
POLL_INTERVAL_MS=2000
POLL_TIMEOUT_MS=300000
```

### 3c. web — no env file needed (relative paths; see §1).

---

## 4. nginx (host) — `/etc/nginx/sites-available/rithm`

```nginx
server {
    listen 80;
    server_name _;                          # set to the domain later
    client_max_body_size 8m;

    root /opt/rithm-phase1/web/dist;         # match the clone path
    index index.html;

    # SPA — serve files, fall back to index.html for client-side routes
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API — KEEP the /api prefix (routes are /api/v1/..). No trailing slash on proxy_pass.
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # gen-proxy — trailing slash on proxy_pass STRIPS /gen (matches the vite rewrite).
    #   /gen/generate -> /generate, /gen/audio?path=.. -> /audio?path=..
    location /gen/ {
        proxy_pass http://127.0.0.1:8090/;
        proxy_read_timeout 600s;             # generation blocks for minutes
        proxy_send_timeout 600s;
        proxy_buffering off;                 # stream audio bytes
        proxy_set_header Host $host;
    }
}
```
Enable: `ln -s /etc/nginx/sites-available/rithm /etc/nginx/sites-enabled/rithm && nginx -t && systemctl reload nginx`.

---

## 5. Execution steps (run on the EC2)

```bash
# 1. Host prerequisites (Amazon Linux 2023 / Ubuntu equivalents)
#    - Docker Engine + docker compose plugin
#    - nginx
#    - Node 20 (only to build the web SPA)
#    - git
#    (ACE-Step is already running on :8001 — leave it.)

# 2. Clone + checkout the exact branch
sudo mkdir -p /opt && cd /opt
git clone <REPO_URL> rithm-phase1
cd rithm-phase1
git checkout ckpt-1-sync-worker-demo      # the current/demo branch

# 3. Add the two new repo files (already committed per §2) — confirm present:
ls gen-proxy/Dockerfile docker-compose.ec2.yml

# 4. Create env files (§3)
#    - copy .env.local from dev (real Cognito + AWS creds)
#    - create gen-proxy/.env with ACESTEP_API_BASE=http://host.docker.internal:8001

# 5. Build the web SPA  -> web/dist
cd web && npm ci && npm run build && cd ..

# 6. Bring up the stack (Postgres auto-runs ops/db/*.sql; LocalStack auto-inits)
docker compose -f docker-compose.yml -f docker-compose.ec2.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.ec2.yml ps

# 7. nginx (§4)
sudo cp <site-config> /etc/nginx/sites-available/rithm   # paste the block from §4
sudo ln -s /etc/nginx/sites-available/rithm /etc/nginx/sites-enabled/rithm
sudo nginx -t && sudo systemctl reload nginx
```

### Security group / firewall
- **Inbound:** 22 (SSH), 80 (HTTP). Add 443 when TLS is set up.
- **Do NOT** expose 8080 / 8090 / 5432 / 4566 publicly (compose binds them to 127.0.0.1 anyway).
- **ACE-Step `:8001`** — restrict to localhost / the SG itself; the browser never touches it now.
- **Outbound:** allow 443 so the API can reach `cognito-idp.<region>.amazonaws.com` and the JWKS URL.

---

## 6. Verification (end-to-end)

```bash
# Services up & healthy
docker compose -f docker-compose.yml -f docker-compose.ec2.yml ps
docker compose -f docker-compose.yml -f docker-compose.ec2.yml logs api | grep startup_complete

# API health
curl -s http://127.0.0.1:8080/health                 # {"status":"ok","version":"0.1.0"}

# gen-proxy health (also proves it can reach ACE-Step on the host)
curl -s http://127.0.0.1:8090/health                 # {"status":"ok","upstream":"ok",...}
```

Then in a browser at `http://<ec2-public-dns>/`:
1. **SPA loads.**
2. **Auth:** sign up → log in. Confirms Cognito `sign_up` + `admin_set_user_password`, `initiate_auth`, JWKS validation on a protected call, and the `identity.users` upsert in Postgres.
3. **Generation:** submit a prompt → `/gen/generate` blocks then returns a track; the player streams `/gen/audio?path=...`. Confirms nginx → gen-proxy → ACE-Step → audio passthrough.
4. **Lockdown:** from outside the SG, confirm 8080/8090/5432 are unreachable and only port 80 responds.

---

## 7. Domain + TLS (later — not part of the initial bring-up)

When the domain is ready (no app or Cognito changes needed — everything is origin-agnostic):
1. Point an A record at the EC2's public IP (consider an Elastic IP so it's stable).
2. Set `server_name <domain>;` in the nginx config.
3. `sudo certbot --nginx -d <domain>` (installs + auto-renews a Let's Encrypt cert, rewrites the server block to 443). *Or* terminate TLS at an ALB / CloudFront in front of the EC2.
4. Reload nginx. Auth and `/api` `/gen` routing keep working unchanged.

---

## 8. Notes, knobs & risks

- The `api` service runs the **dev** compose target (hot-reload, `/docs` enabled, `ENVIRONMENT=local`). Fine for an exact mirror/demo; CORS is irrelevant behind same-origin nginx. To harden later: switch the `api` build to the `production` Dockerfile target, set `ENVIRONMENT=prod`, and set `CLOUDFRONT_DISTRIBUTION_DOMAIN`/an allowed origin (see `api/app/middleware/cors.py`). Out of scope now.
- If ACE-Step has **no 5Hz LM** loaded, set `THINKING=false` in `gen-proxy/.env`.
- Postgres and LocalStack data persist in named volumes (`rithm_pgdata`, `localstackdata`) across restarts. To re-run the DB init SQL, remove the `rithm_pgdata` volume.
- The `worker/` directory ships as-is (empty stub) but is **not run** — it needs a GPU and isn't in compose. ACE-Step itself is the model server.
- `gen-proxy` reaches the host's ACE-Step via `host.docker.internal` (mapped by `extra_hosts: host-gateway`). If that ever fails on the host's Docker version, alternatives: `network_mode: host` on the gen-proxy service (then it binds host `:8090` directly), or point `ACESTEP_API_BASE` at the EC2 private IP.

---

## 9. File-change summary

| Action | Path | Purpose |
|--------|------|---------|
| **add** | `gen-proxy/Dockerfile` | containerize gen-proxy for compose |
| **add** | `docker-compose.ec2.yml` | override: loopback ports + gen-proxy service |
| **add** | `ops/db/06_generation_history.sql` | durable `generation.history` table (auto-runs on first Postgres boot) |
| **create on host** | `.env.local` | real Cognito + AWS creds (copied from dev) |
| **create on host** | `gen-proxy/.env` | `ACESTEP_API_BASE=http://host.docker.internal:8001` |
| **create on host** | `/etc/nginx/sites-available/rithm` | serve SPA + proxy `/api` `/gen` |
| build artifact | `web/dist/` | `npm run build` output served by nginx |
| unchanged | everything else (app code, `docker-compose.yml`, `ops/db/00–05`, `worker/`) | mirror exact state |

**Deferred (spec only — §10, not part of this deploy):** `api/app/modules/generation/{api,schemas,service}.py`, `api/app/shared/db.py` (generation session dep), `web/src/services/generations.ts`, `web/src/store/generation.ts`.

---

## 10. SPEC (DEFERRED) — durable, server-side generation history

> **Status: NOT executed in the initial bring-up.** This is the design to implement *after* the deploy is up. The `generation.history` table (§2c) may be created now (empty, harmless); the API + frontend wiring below is what makes history durable and cross-device.

### 10.0 Problem
Today, generation history lives only in the browser: `web/src/store/generation.ts` persists a Zustand store to **sessionStorage** (`rithm-generation`, newest-first, capped at 50). It survives a refresh but is lost when the tab/browser closes, and never leaves the device. Goal: persist each generation for the logged-in user in Postgres and hydrate the Library/Recents from the DB.

### 10.1 Data model
Table per §2c: `generation.history`, owned by `cognito_sub` (string from the validated id_token — avoids a cross-schema read into `identity.users`, which `rithm_generation` is not granted). The demo's `GeneratedTrack` maps cleanly:

| `GeneratedTrack` field | column | notes |
|---|---|---|
| `id` (client `${ts}-${i}`) | — | discarded; DB issues a UUID, returned as the new `id` |
| `title` | `title` | |
| `prompt` | `prompt` | |
| `lyrics: string[]` | `lyrics` TEXT | join with `\n` on write; `split('\n')` on read |
| `audioUrl` (`/gen/audio?path=..`) | `audio_url` | stored verbatim (relative → origin-agnostic) |
| `seed` | `seed` | |
| `durationSeconds` | `duration_seconds` | |
| `liked` | `liked` | |
| original `GenerateParams` | `params` JSONB | for re-generation / reproducibility |

### 10.2 API (FastAPI — currently a stub in `api/app/modules/generation/`)
Add an authenticated router, mounted at `/api/v1` (alongside identity in `api/app/main.py:60`). All endpoints require a valid Cognito id_token; reuse the existing token dependency in `api/app/shared/auth.py` to obtain the caller's `sub`. Use a **generation** DB session bound to `DB_GENERATION_DSN` (add `get_generation_db` to `api/app/shared/db.py`, mirroring the identity session dep, committing on success).

- **`POST /api/v1/generations`** — body = `{title?, prompt, lyrics[], audioUrl, seed?, durationSeconds?, params?}`. Insert one row with `id = uuid7()`, `cognito_sub` from the token. Returns the saved record incl. `id`, `created_at`. (Frontend calls this once per returned track.)
- **`GET /api/v1/generations?limit=50`** — return the caller's rows, newest-first (uses `history_sub_created_idx`). Shape each row back into a `GeneratedTrack`.
- **`PATCH /api/v1/generations/{id}/like`** — body `{liked: bool}`; update where `id` AND `cognito_sub` match (ownership guard). Returns 404 if not owned.
- **`DELETE /api/v1/generations/{id}`** — ownership-guarded delete. Returns 204.

`schemas.py`: Pydantic `GenerationCreate`, `GenerationOut`. `service.py`: parameterized `INSERT`/`SELECT`/`UPDATE`/`DELETE` via SQLAlchemy `text()` (same pattern as `identity/service.py`). Enforce ownership by always filtering on `cognito_sub` — never trust a client-supplied owner.

### 10.3 Frontend
New `web/src/services/generations.ts` using `apiFetch` (it already attaches the `Bearer` id_token — see `web/src/lib/api.ts`):
```ts
saveGeneration(track, params) -> POST /api/v1/generations  // returns GeneratedTrack w/ server id
listGenerations(limit=50)     -> GET  /api/v1/generations
setLiked(id, liked)           -> PATCH /api/v1/generations/{id}/like
deleteGeneration(id)          -> DELETE /api/v1/generations/{id}
```
Changes to `web/src/store/generation.ts`:
- **On successful `generate()`** — if the user is authenticated (`useAuth.getState().idToken`), `POST` each new track and replace its client id with the returned server id; then prepend to `history`. If unauthenticated, keep the current sessionStorage-only behaviour (no save).
- **Hydration** — on app load / login, call `listGenerations()` and seed `history` from the DB (DB is the source of truth for logged-in users; sessionStorage becomes a transient cache / offline fallback).
- **`toggleLike` / `removeTrack`** — fire the corresponding `PATCH` / `DELETE` (optimistic update, revert on failure).
- Keep `HISTORY_LIMIT`/UI unchanged; `Recents`/`RecentCreations` already read `history`, so they work unchanged once it's DB-backed.

### 10.4 Notes & guards
- **Auth boundary:** `/gen/*` (generation itself) stays unauthenticated as today; only the *persistence* endpoints under `/api/*` require a token. A logged-out user can still generate — it just won't be saved.
- **Ownership:** every read/write filters by the token's `sub`; never accept a user/owner id from the client body.
- **No S3:** `audio_url` points back through `/gen/audio?path=...` (ACE-Step on the host). If ACE-Step's audio files are ephemeral, old history rows may reference audio that no longer resolves — acceptable for the demo; durable audio storage (S3) is a later phase tied to the `worker`/`catalog.tracks` pipeline.
- **Migration:** `06_generation_history.sql` only runs on a *fresh* Postgres volume. If the DB already exists when §10 is implemented, apply the DDL manually (`psql`) or drop/recreate the `rithm_pgdata` volume in a dev/demo context.

### 10.5 Implementation checklist
- [ ] `ops/db/06_generation_history.sql` present (table + index + trigger).
- [ ] `get_generation_db` dependency in `api/app/shared/db.py`.
- [ ] `generation/{schemas,service,api}.py` implemented; router mounted in `main.py`.
- [ ] `web/src/services/generations.ts` added.
- [ ] `web/src/store/generation.ts`: save-on-generate, DB hydration, like/delete sync, auth-gating.
- [ ] Verify: log in → generate → row appears in `generation.history`; reload in a different browser → history loads from DB; like/delete persist.
