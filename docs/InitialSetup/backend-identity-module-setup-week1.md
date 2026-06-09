# SPEC: Section C — Backend Identity Module (Complete)
**Scope:** `api/.env` (partial update), all backend files for the Identity module, `__init__.py`
files for every new package, dependency install, run command, and verification.

---

## Context

This is a FastAPI modular monolith. The Identity module handles signup, login, token
refresh, and the `/me` endpoint. Auth is backend-mediated: the API calls Cognito via
boto3 (no Amplify in the browser). Tokens are Cognito RS256 JWTs; validation uses
PyJWT + JWKS caching. The `identity.users` table in Postgres is the local user profile,
linked to Cognito via `cognito_sub`.

---

## Directory tree after this spec is applied

```
api/
├── .env                          ← partial update (keep existing Cognito IDs)
├── pyproject.toml                ← uv adds new deps
└── app/
    ├── __init__.py               ← CREATE (empty)
    ├── config.py                 ← CREATE
    ├── db.py                     ← CREATE
    ├── main.py                   ← CREATE
    ├── shared/
    │   ├── __init__.py           ← CREATE (empty)
    │   └── auth.py               ← CREATE
    └── modules/
        ├── __init__.py           ← CREATE (empty)
        └── identity/
            ├── __init__.py       ← CREATE (empty)
            ├── api.py            ← CREATE
            ├── schemas.py        ← CREATE
            └── service.py        ← CREATE
```

---

## Step 0 — Install dependencies

Run from the `api/` directory:

```bash
cd api
uv add fastapi "uvicorn[standard]" "pydantic[email]" pydantic-settings \
       "sqlalchemy[asyncio]" asyncpg boto3 "pyjwt[crypto]" uuid-utils
```

---

## Step 1 — Update `api/.env`

**Instruction:** Update `api/.env` so it matches the full content below.
`COGNITO_USER_POOL_ID` and `COGNITO_APP_CLIENT_ID` are already present with real
values — **preserve those two lines exactly as they are**. Add or overwrite every other
line shown.

```dotenv
ENVIRONMENT=local
LOG_LEVEL=DEBUG

# Database — per-module DSN using the identity role created in 00_init.sql
DB_IDENTITY_DSN=postgresql+asyncpg://rithm_identity:dev_identity_pw@localhost:5432/rithm

# AWS — boto3 and JWKS validation both use these
AWS_DEFAULT_REGION=us-east-1
COGNITO_USER_POOL_ID=<keep existing value>
COGNITO_APP_CLIENT_ID=<keep existing value>

# Consent — must match the value sent by the frontend on signup
CURRENT_CONSENT_VERSION=tos-2026-05

# CORS — allow the Vite dev server
WEB_ORIGIN=http://localhost:5173
```

---

## Step 2 — `api/app/__init__.py`

Create as an empty file:

```python
```

---

## Step 3 — `api/app/config.py`

```python
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    environment: str = "local"
    log_level: str = "INFO"

    # Database
    db_identity_dsn: str

    # Cognito / AWS
    aws_default_region: str = "us-east-1"
    cognito_user_pool_id: str
    cognito_app_client_id: str

    # Consent
    current_consent_version: str = "tos-2026-05"

    # CORS
    web_origin: str = "http://localhost:5173"


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

---

## Step 4 — `api/app/db.py`

Session 1 touches only `identity.users`, so a single async engine on the identity DSN
is all that is needed. Additional per-module engines are added in later sessions.

```python
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings

_settings = get_settings()

engine = create_async_engine(
    _settings.db_identity_dsn,
    pool_size=5,
    max_overflow=5,
    pool_pre_ping=True,
)

SessionLocal = async_sessionmaker(
    engine,
    expire_on_commit=False,
    class_=AsyncSession,
)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
```

---

## Step 5 — `api/app/shared/__init__.py`

Create as an empty file:

```python
```

---

## Step 6 — `api/app/shared/auth.py`

Validates Cognito RS256 id_tokens via JWKS (keys cached in-process).
`require_claims` — parses and verifies the Bearer token.
`require_user`   — resolves cognito_sub → local `identity.users.id` (lazy-creates row if
                   this is the user's first request after signup).

```python
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, Request, status
from jwt import PyJWKClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid_utils import uuid7

from app.config import get_settings
from app.db import get_db

_settings = get_settings()

_ISSUER = (
    f"https://cognito-idp.{_settings.aws_default_region}.amazonaws.com/"
    f"{_settings.cognito_user_pool_id}"
)

# PyJWKClient fetches and caches the public keys from Cognito's JWKS endpoint.
_jwk_client = PyJWKClient(
    f"{_ISSUER}/.well-known/jwks.json",
    cache_keys=True,
)


def _decode(token: str) -> dict:
    signing_key = _jwk_client.get_signing_key_from_jwt(token).key
    return jwt.decode(
        token,
        signing_key,
        algorithms=["RS256"],
        audience=_settings.cognito_app_client_id,
        issuer=_ISSUER,
        options={"require": ["exp", "iss", "sub"]},
    )


async def require_claims(request: Request) -> dict:
    """Extract and verify the Bearer id_token. Returns the decoded claims dict."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    try:
        claims = _decode(auth.split(" ", 1)[1])
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    # We only accept id_tokens (not access tokens) as the bearer credential.
    if claims.get("token_use") != "id":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong token type — id_token required")
    return claims


async def require_user(
    claims: dict = Depends(require_claims),
    db: AsyncSession = Depends(get_db),
) -> UUID:
    """
    Resolve cognito_sub → local user_id (UUID).
    Creates the identity.users row lazily on the user's first authenticated request
    (ON CONFLICT DO NOTHING handles any race between signup and first login).
    """
    sub: str = claims["sub"]

    row = (
        await db.execute(
            text("SELECT id FROM identity.users WHERE cognito_sub = :sub"),
            {"sub": sub},
        )
    ).first()

    if row:
        return row[0]

    # Lazy creation — signup endpoint also inserts, so ON CONFLICT is the safety net.
    await db.execute(
        text("""
            INSERT INTO identity.users (id, cognito_sub, email)
            VALUES (:id, :sub, :email)
            ON CONFLICT (cognito_sub) DO NOTHING
        """),
        {"id": str(uuid7()), "sub": sub, "email": claims.get("email", "")},
    )
    await db.commit()

    row = (
        await db.execute(
            text("SELECT id FROM identity.users WHERE cognito_sub = :sub"),
            {"sub": sub},
        )
    ).first()

    return row[0]
```

---

## Step 7 — `api/app/modules/__init__.py`

Create as an empty file:

```python
```

---

## Step 8 — `api/app/modules/identity/__init__.py`

Create as an empty file:

```python
```

---

## Step 9 — `api/app/modules/identity/schemas.py`

```python
from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    consent_version: str


class SignupResponse(BaseModel):
    user_id: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    id_token: str
    refresh_token: str | None = None
    expires_in: int
    token_type: str


class MeResponse(BaseModel):
    user_id: str
    email: str
    is_admin: bool
```

---

## Step 10 — `api/app/modules/identity/service.py`

boto3 Cognito calls are synchronous; `run_in_threadpool` offloads them to a thread pool
so they do not block the async event loop.

Phase 1: `AdminConfirmSignUp` is called immediately after `SignUp` so users can log in
without completing an email verification step.

```python
import boto3
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid_utils import uuid7

from app.config import get_settings

_settings = get_settings()

_cognito = boto3.client(
    "cognito-idp",
    region_name=_settings.aws_default_region,
)


class IdentityService:

    async def signup(
        self,
        db: AsyncSession,
        email: str,
        password: str,
    ) -> str:
        """
        Register a new user in Cognito and create the local identity.users row.
        Returns the new local user_id as a string.
        """
        resp = await run_in_threadpool(
            _cognito.sign_up,
            ClientId=_settings.cognito_app_client_id,
            Username=email,
            Password=password,
            UserAttributes=[{"Name": "email", "Value": email}],
        )
        sub: str = resp["UserSub"]

        # Phase 1: bypass email verification — confirm the user immediately.
        await run_in_threadpool(
            _cognito.admin_confirm_sign_up,
            UserPoolId=_settings.cognito_user_pool_id,
            Username=email,
        )

        user_id = str(uuid7())
        await db.execute(
            text("""
                INSERT INTO identity.users
                    (id, cognito_sub, email, consent_accepted_at, consent_version)
                VALUES (:id, :sub, :email, now(), :cv)
                ON CONFLICT (cognito_sub) DO NOTHING
            """),
            {
                "id": user_id,
                "sub": sub,
                "email": email,
                "cv": _settings.current_consent_version,
            },
        )
        await db.commit()
        return user_id

    async def login(self, email: str, password: str) -> dict:
        """Authenticate via USER_PASSWORD_AUTH. Returns the raw AuthenticationResult dict."""
        resp = await run_in_threadpool(
            _cognito.initiate_auth,
            ClientId=_settings.cognito_app_client_id,
            AuthFlow="USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": email, "PASSWORD": password},
        )
        return resp["AuthenticationResult"]

    async def refresh(self, refresh_token: str) -> dict:
        """Exchange a refresh token for a new id_token. Returns AuthenticationResult dict."""
        resp = await run_in_threadpool(
            _cognito.initiate_auth,
            ClientId=_settings.cognito_app_client_id,
            AuthFlow="REFRESH_TOKEN_AUTH",
            AuthParameters={"REFRESH_TOKEN": refresh_token},
        )
        return resp["AuthenticationResult"]


# Module-level singleton — boto3 client is thread-safe and reused across requests.
identity_service = IdentityService()
```

---

## Step 11 — `api/app/modules/identity/api.py`

```python
from uuid import UUID

from botocore.exceptions import ClientError
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.shared.auth import require_user
from app.modules.identity.schemas import (
    LoginRequest,
    MeResponse,
    RefreshRequest,
    SignupRequest,
    SignupResponse,
    TokenResponse,
)
from app.modules.identity.service import identity_service

router = APIRouter(tags=["identity"])
_settings = get_settings()

# Map Cognito error codes to HTTP status codes.
_COGNITO_HTTP: dict[str, int] = {
    "UsernameExistsException":      status.HTTP_409_CONFLICT,
    "InvalidPasswordException":     status.HTTP_400_BAD_REQUEST,
    "InvalidParameterException":    status.HTTP_400_BAD_REQUEST,
    "NotAuthorizedException":       status.HTTP_401_UNAUTHORIZED,
    "UserNotFoundException":        status.HTTP_401_UNAUTHORIZED,
    "UserNotConfirmedException":    status.HTTP_403_FORBIDDEN,
}


def _http(err: ClientError) -> HTTPException:
    code = err.response["Error"]["Code"]
    msg  = err.response["Error"].get("Message", code)
    return HTTPException(_COGNITO_HTTP.get(code, status.HTTP_400_BAD_REQUEST), msg)


@router.post("/auth/signup", response_model=SignupResponse, status_code=201)
async def signup(
    body: SignupRequest,
    db: AsyncSession = Depends(get_db),
):
    if body.consent_version != _settings.current_consent_version:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Stale consent version '{body.consent_version}'. "
            f"Expected '{_settings.current_consent_version}'. Reload the page and retry.",
        )
    try:
        user_id = await identity_service.signup(db, body.email, body.password)
    except ClientError as exc:
        raise _http(exc)
    return SignupResponse(user_id=user_id)


@router.post("/auth/login", response_model=TokenResponse)
async def login(body: LoginRequest):
    try:
        result = await identity_service.login(body.email, body.password)
    except ClientError as exc:
        raise _http(exc)
    return TokenResponse(
        id_token=result["IdToken"],
        refresh_token=result["RefreshToken"],
        expires_in=result["ExpiresIn"],
        token_type=result["TokenType"],
    )


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest):
    try:
        result = await identity_service.refresh(body.refresh_token)
    except ClientError as exc:
        raise _http(exc)
    return TokenResponse(
        id_token=result["IdToken"],
        refresh_token=None,          # Cognito does not rotate the refresh token here
        expires_in=result["ExpiresIn"],
        token_type=result["TokenType"],
    )


@router.get("/me", response_model=MeResponse)
async def me(
    user_id: UUID = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    row = (
        await db.execute(
            text("SELECT email, is_admin FROM identity.users WHERE id = :id"),
            {"id": str(user_id)},
        )
    ).first()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return MeResponse(user_id=str(user_id), email=row[0], is_admin=row[1])
```

---

## Step 12 — `api/app/main.py`

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.modules.identity.api import router as identity_router


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="RITHM API",
        version="0.1.0",
        # Swagger UI only available locally — never exposed in prod.
        docs_url="/docs" if settings.environment == "local" else None,
        redoc_url=None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.web_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health", tags=["ops"])
    async def health() -> dict:
        return {"status": "ok"}

    app.include_router(identity_router, prefix="/api/v1")

    return app


app = create_app()
```

---

## Step 13 — Run

All commands from the `api/` directory (where `.env` and `pyproject.toml` live):

```bash
cd api
uv run uvicorn app.main:app --reload --port 8000
```

Expected startup output (no errors):
```
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:     Started reloader process ...
INFO:     Started server process ...
INFO:     Waiting for application startup.
INFO:     Application startup complete.
```

---

## Step 14 — Verify

Run each check in a separate shell while the server is running.

```bash
# ── 1. Health ─────────────────────────────────────────────────────────────────
curl -s localhost:8000/health
# Expected: {"status":"ok"}

# ── 2. Swagger UI loaded ─────────────────────────────────────────────────────
# Open http://localhost:8000/docs in a browser.
# Expected: Swagger UI showing /auth/signup, /auth/login, /auth/refresh, /me, /health

# ── 3. Signup ─────────────────────────────────────────────────────────────────
curl -s -X POST localhost:8000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@rithm.dev","password":"Test1234","consent_version":"tos-2026-05"}' \
  | python3 -m json.tool
# Expected: {"user_id": "<uuid>"}  with HTTP 201

# ── 4. Login ──────────────────────────────────────────────────────────────────
TOKEN=$(curl -s -X POST localhost:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@rithm.dev","password":"Test1234"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id_token'])")

echo "TOKEN acquired: ${TOKEN:0:40}..."
# Expected: a JWT string starting with "eyJ"

# ── 5. Protected /me ──────────────────────────────────────────────────────────
curl -s localhost:8000/api/v1/me \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -m json.tool
# Expected: {"user_id": "<uuid>", "email": "test@rithm.dev", "is_admin": false}

# ── 6. 401 with no token ──────────────────────────────────────────────────────
curl -s -o /dev/null -w "%{http_code}" localhost:8000/api/v1/me
# Expected: 401

# ── 7. 401 with a garbage token ───────────────────────────────────────────────
curl -s -o /dev/null -w "%{http_code}" localhost:8000/api/v1/me \
  -H "Authorization: Bearer not.a.real.token"
# Expected: 401

# ── 8. Duplicate signup returns 409 ──────────────────────────────────────────
curl -s -o /dev/null -w "%{http_code}" \
  -X POST localhost:8000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@rithm.dev","password":"Test1234","consent_version":"tos-2026-05"}'
# Expected: 409

# ── 9. Stale consent version returns 400 ──────────────────────────────────────
curl -s -o /dev/null -w "%{http_code}" \
  -X POST localhost:8000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"other@rithm.dev","password":"Test1234","consent_version":"tos-old"}'
# Expected: 400

# ── 10. User row in Postgres ──────────────────────────────────────────────────
docker compose exec postgres psql -U rithm_admin -d rithm -c \
  "SELECT id, email, cognito_sub, consent_version, created_at FROM identity.users;"
# Expected: one row for test@rithm.dev with consent_version = 'tos-2026-05'

# ── 11. Token refresh ─────────────────────────────────────────────────────────
REFRESH=$(curl -s -X POST localhost:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@rithm.dev","password":"Test1234"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['refresh_token'])")

curl -s -X POST localhost:8000/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refresh_token\": \"$REFRESH\"}" \
  | python3 -m json.tool
# Expected: new id_token, no refresh_token in response (Cognito does not rotate it here)
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `pydantic_core.ValidationError: cognito_user_pool_id` on startup | `.env` missing the variable or wrong key name | Confirm `COGNITO_USER_POOL_ID` is in `api/.env` and `uvicorn` is run from `api/` |
| `ModuleNotFoundError: No module named 'app'` | Wrong working directory | Run from `api/`, not from repo root |
| `botocore.exceptions.NoCredentialsError` | No AWS credentials found | Run `aws configure` or export `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| Signup returns 400 `NotAuthorizedException` | `ALLOW_USER_PASSWORD_AUTH` not enabled on the app client | In Cognito console → App integration → App clients → `rithm-web-dev` → edit auth flows |
| Signup returns 403 `UserNotConfirmedException` | `AdminConfirmSignUp` call failed (IAM) | Ensure the AWS identity used has `cognito-idp:AdminConfirmSignUp` permission |
| `/me` returns 401 even with valid token | `token_use` is `access` not `id` | The frontend must send the `id_token` field, not `access_token` |
| CORS error in browser | `WEB_ORIGIN` mismatch | Confirm `WEB_ORIGIN=http://localhost:5173` in `.env` and Vite is on port 5173 |