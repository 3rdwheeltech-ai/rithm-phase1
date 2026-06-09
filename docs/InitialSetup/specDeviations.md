# Spec Deviations Log

Deviations from `RITHM_Days1to5_CodeSpec.md` discovered during implementation.
The spec doc itself is left untouched; this file is the record of where and why
the code differs. Each entry notes the spec section, the problem, and the fix
applied in code.

---

## Day 1 (implemented 2026-06-04)

### 1. Missing hatchling wheel target in both `pyproject.toml` files

- **Spec**: `api/pyproject.toml` (Day 1 §) and `worker/pyproject.toml` (Day 1 §)
- **Files**: `api/pyproject.toml`, `worker/pyproject.toml`
- **Problem**: The spec's pyprojects declare `build-backend = "hatchling.build"` but no
  build target. Hatchling auto-discovers packages matching the project name
  (`rithm_api` / `rithm_worker`), which doesn't match the actual package dirs
  (`app/`, `worker/`). `uv sync --frozen` fails with a wheel build error.
- **Fix**: Added to each file:

  ```toml
  [tool.hatch.build.targets.wheel]
  packages = ["app"]      # "worker" in worker/pyproject.toml
  ```

### 2. `structlog.stdlib.add_logger_name` incompatible with `PrintLoggerFactory`

- **Spec**: `api/app/shared/logging.py` (Day 2 §, pulled forward)
- **File**: `api/app/shared/logging.py`
- **Problem**: The spec's processor chain includes `structlog.stdlib.add_logger_name`,
  which reads `logger.name` — but `logger_factory=structlog.PrintLoggerFactory()`
  produces `PrintLogger` instances that have no `.name` attribute. The first log call
  in `init_db_engines()` raises `AttributeError: 'PrintLogger' object has no attribute
  'name'` and **API startup crashes**.
- **Fix**: Removed the `add_logger_name` processor from the chain (comment left in code).
  Alternative if logger names are wanted later: switch to
  `structlog.stdlib.LoggerFactory()` with stdlib logging config.

### 3. Error handler registered on the wrong `HTTPException` class

- **Spec**: `api/app/middleware/error_handler.py` (Day 2 §, pulled forward)
- **File**: `api/app/middleware/error_handler.py`
- **Problem**: The spec imports `HTTPException` from `fastapi` and registers the
  handler on it. Router-level 404/405s are raised by Starlette as
  `starlette.exceptions.HTTPException` (the *parent* class), which a handler
  registered on the FastAPI subclass never catches. Result: `GET /nonexistent`
  returned Starlette's default `{"detail": "Not Found"}` instead of RFC 7807
  problem+json — caught by the spec's own `test_404_returns_problem_json`.
- **Fix**: Register the handler on `starlette.exceptions.HTTPException` instead.
  `fastapi.HTTPException` subclasses it, so all custom exceptions in
  `app/shared/exceptions.py` are still handled by the same handler.

---

## Section C — Identity module (implemented 2026-06-07)

Deviations from `backend-identity-module-setup-week1.md`. That spec assumes a
greenfield `api/`; the scaffold from Days 1–5 already existed, so the spec's
endpoint contracts were kept verbatim while the plumbing was adapted.

### 4. `app/db.py` not created — existing `shared/db.py` used instead

- **Spec**: Step 4 (`api/app/db.py` with module-level engine + `get_db()`)
- **File**: `api/app/shared/db.py`
- **Problem**: The codebase already has lifespan-initialized per-module engines
  (`init_db_engines()` / `get_session(module)`), which the spec's module-level
  single engine would duplicate and bypass.
- **Fix**: Added a thin FastAPI dependency `get_identity_db()` that wraps
  `get_session("identity")`. Everywhere the spec says `Depends(get_db)`, the code
  uses `Depends(get_identity_db)`. Because `get_session` commits on successful
  exit, the spec's explicit `await db.commit()` calls were dropped;
  `require_user`'s lazy-insert path uses `await db.flush()` before re-selecting.

### 5. `config.py` / `main.py` not replaced — existing supersets kept

- **Spec**: Steps 1, 3, 12
- **Files**: `api/app/config.py`, `api/app/main.py`, `api/.env`
- **Problem**: The spec's minimal `config.py`/`main.py` would discard the existing
  multi-module settings, lifespan, structlog, request-id, and RFC 7807 stack.
- **Fix**: Kept existing files. Field name is `aws_region` (not the spec's
  `aws_default_region`). No `WEB_ORIGIN` setting — CORS for `localhost:5173` is
  already handled by `app/middleware/cors.py:setup_cors()`. The only `main.py`
  change was uncommenting the identity router include (prefix `/api/v1`, as spec'd).

### 6. Cognito boto3 client pinned to the real AWS endpoint

- **Spec**: Step 10 (`boto3.client("cognito-idp", region_name=...)`)
- **File**: `api/app/modules/identity/service.py`
- **Problem**: The api container sets `AWS_ENDPOINT_URL=http://localstack:4566`
  (for S3/SQS/SNS), which boto3 honors globally — the spec's client would route
  Cognito calls to LocalStack instead of the real dev pool, and LocalStack's
  Cognito coverage is incomplete.
- **Fix**: Client created with explicit
  `endpoint_url=f"https://cognito-idp.{region}.amazonaws.com"`.

### 7. Real AWS credentials required in `.env.local`

- **Spec**: Troubleshooting table (`aws configure`)
- **File**: `.env.local` (gitignored)
- **Problem**: `.env.local` carried LocalStack placeholder creds (`test`/`test`).
  `AdminConfirmSignUp` is a SigV4-authenticated admin API on the real pool and
  rejects them.
- **Fix**: The real `rithm-dev` IAM key pair (needs `cognito-idp:AdminConfirmSignUp`)
  replaces the placeholders. LocalStack accepts any credential values, so
  S3/SQS/SNS flows are unaffected.

### 8. Error bodies are RFC 7807 problem+json, not `{"detail": ...}`

- **Spec**: Steps 11, 14 (implicitly FastAPI's default error shape)
- **File**: `api/app/middleware/error_handler.py` (pre-existing)
- **Problem**: The Day-2 error handler renders every `HTTPException` as RFC 7807
  problem+json; the message lands in `"title"`, not `"detail"`.
- **Fix**: None needed in code — status codes match the spec exactly. Frontend and
  tests must read `title` (and `detail` for 422 validation errors).

### 9. Verification target is the docker api container, not bare uvicorn

- **Spec**: Steps 13–14 (`uvicorn --port 8000`, db `rithm`, postgres `:5432`)
- **Problem**: The established dev flow runs the api in docker on `:8080` against
  db `rithm-dev` (host port `5433`); this matches the prod ECS path.
- **Fix**: Spec Step 14 commands run with `localhost:8000 → localhost:8080` and
  `-d rithm → -d rithm-dev`. Adding the `pyjwt[crypto]` dep requires a one-off
  `docker compose build api` (deps bake at image build; only `app/` is volume-mounted).

### 10. App client has a secret — SECRET_HASH added to all Cognito calls

- **Spec**: Steps 9–11 (assumed a public, no-secret app client)
- **Files**: `api/app/config.py`, `api/app/modules/identity/service.py`,
  `api/app/modules/identity/{schemas,api}.py`
- **Problem**: The dev app client `2i1f…uehm` was created WITH a client secret.
  Cognito then rejects `SignUp`/`InitiateAuth` unless a `SECRET_HASH`
  (Base64 HMAC-SHA256 of `username + client_id`, keyed by the secret) accompanies
  every call.
- **Fix**: New setting `COGNITO_APP_CLIENT_SECRET` (SecretStr; in `.env`/`.env.local`,
  placeholder in `.env.example`). `service.py` computes `_secret_hash(username)` for
  signup (email), login (email) and refresh. **Contract change:** `POST /auth/refresh`
  now requires `email` alongside `refresh_token` — for `REFRESH_TOKEN_AUTH` the hash
  must use the user's actual Cognito username (sub), which the API resolves from
  `identity.users.cognito_sub` by email.

### 11. User pool requires name, given_name, phone_number at signup

- **Spec**: Step 9/10 (`SignupRequest` was email+password+consent only)
- **Files**: `api/app/modules/identity/schemas.py`, `service.py`, `api.py`
- **Problem**: The dev pool `us-east-1_tGL59md0C` was created with `name`,
  `given_name` and `phone_number` as required attributes (immutable pool config);
  signup fails schema validation without them.
- **Fix**: Per team decision, `SignupRequest` adds `name` (1–128 chars) and
  `phone_number` (E.164-validated). `given_name` is set server-side to the same
  value as `name`. All three are stored in Cognito only — the `identity.users`
  DDL is unchanged. The frontend signup form must collect name and phone.

### 12. docker-compose hardcoded LocalStack AWS creds removed

- **Spec**: Section B compose file (`AWS_ACCESS_KEY_ID: test` in the api
  `environment:` block)
- **File**: `docker-compose.yml`
- **Problem**: The `environment:` block overrides `env_file`, so the real
  `rithm-dev` keys in `.env.local` never reached the container —
  `AdminConfirmSignUp` failed with "security token invalid".
- **Fix**: Dropped `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from the compose
  `environment:` block; creds now flow from `.env.local`. LocalStack accepts any
  credential values, so S3/SQS/SNS are unaffected. `AWS_ENDPOINT_URL` stays in
  compose (container-network hostname).

### 13. Auto-confirm uses AdminSetUserPassword, not AdminConfirmSignUp

- **Spec**: Step 10 (`admin_confirm_sign_up` after `sign_up`); Troubleshooting
  table anticipated the IAM failure
- **File**: `api/app/modules/identity/service.py`
- **Problem**: The scoped dev IAM user `rithm-dev-local` is not granted
  `cognito-idp:AdminConfirmSignUp`, so the spec's auto-confirm step 400'd. It
  *is* granted `cognito-idp:AdminSetUserPassword` (and AdminGetUser /
  AdminDeleteUser / AdminUpdateUserAttributes).
- **Fix**: Signup calls `AdminSetUserPassword(..., Permanent=True)` with the
  user's own password — this transitions an UNCONFIRMED user to CONFIRMED with
  the same end state as `AdminConfirmSignUp`. Revisit if the IAM policy is ever
  widened or Phase 2 introduces real email verification.

---

## Process notes (not code deviations)

- **App client auth flows (Section C)**: the dev app client `rithm` only had
  `ALLOW_USER_AUTH`/`ALLOW_USER_SRP_AUTH`/`ALLOW_REFRESH_TOKEN_AUTH`;
  `ALLOW_USER_PASSWORD_AUTH` was added via `update-user-pool-client` on
  2026-06-07 (all other client settings preserved), as anticipated by the spec's
  troubleshooting table.

- **API service pulled forward on Day 1**: by team decision, `api/Dockerfile`
  (Day 3 §) and the minimal app factory / `/health` stack (Day 2 §) were implemented
  on Day 1 so the full `docker-compose up` works end-to-end from the first day.
  The code is verbatim from the spec's Day 2/3 sections apart from deviations 2–3 above.
- **`version: "3.9"` in docker-compose files**: kept as spec'd, but Docker Compose v2
  warns it is obsolete. Harmless; consider dropping the key when the spec is revised.
