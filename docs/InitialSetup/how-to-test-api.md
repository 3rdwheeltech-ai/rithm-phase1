# How to Test the API (Identity Module)

The API runs in docker on **http://localhost:8080** (see `docker-compose.yml`).
All identity routes are under the `/api/v1` prefix.

```bash
docker compose ps           # rithm-phase1-api-1 should be Up
curl -s localhost:8080/health
# → {"status":"ok","version":"0.1.0"}
```

---

## Option 1 — Swagger UI (interactive)

Open **http://localhost:8080/docs** in a browser. Each endpoint has a
"Try it out" button. Flow: `/auth/signup` → `/auth/login` → copy the
`id_token` → use curl for `/me` (no auth box is wired into Swagger yet).

---

## Option 2 — curl (full flow)

```bash
# ── 1. Signup (use a NEW email each time — duplicates return 409) ──────────
curl -s -X POST localhost:8080/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"you@rithm.dev","password":"Test1234","consent_version":"tos-2026-05","name":"Your Name","phone_number":"+15555550123"}'
# → {"user_id":"<uuid>"}  with HTTP 201

# ── 2. Login → capture tokens ───────────────────────────────────────────────
LOGIN=$(curl -s -X POST localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@rithm.dev","password":"Test1234"}')
TOKEN=$(echo $LOGIN | python3 -c "import sys,json; print(json.load(sys.stdin)['id_token'])")
REFRESH=$(echo $LOGIN | python3 -c "import sys,json; print(json.load(sys.stdin)['refresh_token'])")
echo "TOKEN acquired: ${TOKEN:0:40}..."   # JWT starting with "eyJ"

# ── 3. Protected route ──────────────────────────────────────────────────────
curl -s localhost:8080/api/v1/me -H "Authorization: Bearer $TOKEN"
# → {"user_id":"...","email":"you@rithm.dev","is_admin":false}

# ── 4. Refresh when the id_token expires (60 min) ───────────────────────────
# NOTE: refresh requires email alongside the refresh_token (SECRET_HASH —
# see specDeviations.md #10).
curl -s -X POST localhost:8080/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"you@rithm.dev\",\"refresh_token\":\"$REFRESH\"}"
# → new id_token; refresh_token is null (Cognito does not rotate it here)
```

### Negative checks

```bash
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/api/v1/me                  # 401 no token
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/api/v1/me \
  -H "Authorization: Bearer not.a.real.token"                                      # 401 garbage
# Re-POST the same signup body                                                     # 409 duplicate
# Signup with "consent_version":"tos-old"                                          # 400 stale consent
# Signup with password shorter than 8 chars or a non-E.164 phone                   # 422 validation
```

---

## Option 3 — automated tests (no Cognito / no live DB needed)

```bash
cd api && uv run pytest -v
# tests/test_identity_auth.py — 401s, consent guard, request validation
# tests/test_health.py        — health + problem+json shape
```

---

## Debugging

```bash
docker compose logs api --tail 30        # API errors (structlog JSON, secrets scrubbed)

# Local user rows (also see how-to-test-db.md)
docker compose exec postgres psql -U rithm_admin -d rithm-dev \
  -c "SELECT email, consent_version, created_at FROM identity.users;"
```

---

## Gotchas

- **Send the `id_token`, not `access_token`** — access tokens are rejected by
  design (401 "Wrong token type — id_token required").
- **Error bodies are RFC 7807 problem+json** — the message is in `"title"`,
  not `"detail"` (`detail` carries field errors on 422).
- **Password policy**: min 8 chars; Cognito may additionally require
  upper/lower/digit depending on pool settings.
- **Signup requires `name` and `phone_number`** (E.164, e.g. `+15555550123`) —
  required attributes on the dev user pool (specDeviations.md #11).
- **To re-test signup with the same email**, delete the user in both places:

  ```bash
  AWS_PROFILE=rithm-dev aws cognito-idp admin-delete-user \
    --user-pool-id us-east-1_tGL59md0C --username you@rithm.dev --region us-east-1

  docker compose exec postgres psql -U rithm_admin -d rithm-dev \
    -c "DELETE FROM identity.users WHERE email='you@rithm.dev';"
  ```

- **Cognito throttling**: repeated signup attempts for the same email can
  trigger "Attempt limit exceeded" — wait a few minutes or use a fresh email.
