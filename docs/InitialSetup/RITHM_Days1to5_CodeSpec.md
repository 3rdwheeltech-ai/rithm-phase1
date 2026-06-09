# RITHM Phase 0 — Days 1–5: Code Implementation Spec

> **Purpose**: Spec-driven implementation reference for Claude pair-programming.
> Every artifact is precise enough to generate production-quality code without ambiguity.
> AWS console work is the developer's lane; this document covers the code lane only.

---

## Monorepo Structure (Target State After Day 1)

```
RITHM-PHASE1/
├── api/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── middleware/
│   │   │   ├── __init__.py
│   │   │   ├── request_id.py
│   │   │   ├── error_handler.py
│   │   │   └── cors.py
│   │   ├── shared/
│   │   │   ├── __init__.py
│   │   │   ├── db.py
│   │   │   ├── exceptions.py
│   │   │   ├── logging.py
│   │   │   ├── metrics.py
│   │   │   └── sns_verify.py
│   │   └── modules/
│   │       ├── identity/       __init__.py (stub)
│   │       ├── catalog/        __init__.py (stub)
│   │       ├── generation/     __init__.py (stub)
│   │       ├── conversation/   __init__.py (stub)
│   │       └── personalization/__init__.py (stub)
│   ├── migrations/
│   │   ├── identity/   {alembic.ini, env.py, script.py.mako, versions/}
│   │   ├── catalog/    {same}
│   │   ├── generation/ {same}
│   │   ├── conversation/{same}
│   │   └── personalization/{same}
│   ├── tests/
│   │   ├── __init__.py
│   │   ├── conftest.py
│   │   └── test_health.py
│   ├── pyproject.toml
│   ├── Dockerfile
│   ├── .dockerignore
│   └── .env.example
├── web/
│   ├── src/
│   │   ├── main.tsx          (stub)
│   │   └── App.tsx           (stub)
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.ts
│   ├── index.html
│   └── .env.example
├── worker/
│   ├── worker/
│   │   ├── __init__.py
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── model.py
│   │   ├── processor.py
│   │   ├── storage.py
│   │   ├── messaging.py
│   │   ├── db.py
│   │   └── logging_setup.py
│   ├── tests/
│   │   ├── __init__.py
│   │   └── conftest.py
│   ├── pyproject.toml
│   ├── Dockerfile
│   ├── .dockerignore
│   └── .env.example
├── ops/
│   ├── runbooks/
│   │   ├── dlq-drain.md
│   │   ├── worker-stuck.md
│   │   ├── force-fail-jobs.md
│   │   ├── reset-session.md
│   │   ├── rotate-secrets.md
│   │   ├── restore-db.md
│   │   ├── cognito-recovery.md
│   │   ├── cost-anomaly.md
│   │   └── incident-template.md
│   ├── scripts/
│   │   ├── init-db-users.sql
│   │   ├── init-localstack.sh
│   │   ├── run-migrations.sh
│   │   └── promote-admin.sql
│   ├── task-definitions/
│   │   ├── api.json.template
│   │   └── worker.json.template
│   └── cloudwatch/
│       ├── alarms.json
│       └── dashboards/
│           ├── rithm-ops.json
│           └── rithm-cost.json
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── deploy-web.yml
│       ├── deploy-api.yml
│       └── deploy-worker.yml
├── docker-compose.yml
├── docker-compose.test.yml
├── .gitignore
├── .env.example
└── README.md
```

---

## DAY 1 — Monorepo Scaffold

**Goal**: Repo is initialized. `docker-compose up` starts Postgres + LocalStack. Every package has a working `pyproject.toml` / `package.json`. CI workflow stubs exist. Zero feature code.

---

### `rithm/.gitignore`

```
# Python
__pycache__/
*.py[cod]
*.egg-info/
.venv/
.env
dist/
.pytest_cache/
.mypy_cache/
.ruff_cache/
*.pyc

# JS/Node
node_modules/
web/dist/

# Secrets / local config
.env.local
*.pem
*.key

# Docker
.dockerignore

# IDE
.vscode/
.idea/
*.DS_Store

# Test artifacts
playwright-report/
test-results/
```

---

### `api/pyproject.toml`

**Key decisions called out below — do not deviate:**

```toml
[project]
name = "rithm-api"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.110",
    "uvicorn[standard]>=0.29",
    "pydantic[email]>=2.7",
    "pydantic-settings>=2.3",
    "sqlalchemy[asyncio]>=2.0",
    "asyncpg>=0.29",
    "alembic>=1.13",
    "structlog>=24.1",
    "aioboto3>=13.1",
    "aws-embedded-metrics>=3.2",
    "apscheduler>=3.10",
    "cryptography>=42.0",
    "uuid-utils>=0.9",          # UUIDv7 generation — Rust-backed, fast
    "tiktoken>=0.7",            # conversation token counting
    "httpx>=0.27",              # Cognito JWKS fetch + SNS confirm URL
    "python-multipart>=0.0.9",  # voice file upload
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.uv]
dev-dependencies = [
    "pytest>=8.2",
    "pytest-asyncio>=0.23",
    "pytest-httpx>=0.30",
    "anyio>=4.4",
    "ruff>=0.5",
    "pyright>=1.1",
    "import-linter>=2.1",
    "factory-boy>=3.3",
]

# ── Import boundary enforcement ─────────────────────────────────
# A module may ONLY depend on shared/ and its own interfaces.py.
# Direct cross-module imports fail CI.
[tool.importlinter]
root_package = "app"

[[tool.importlinter.contracts]]
name = "Module independence"
type = "independence"
modules = [
    "app.modules.identity",
    "app.modules.catalog",
    "app.modules.generation",
    "app.modules.conversation",
    "app.modules.personalization",
]

# ── Test configuration ──────────────────────────────────────────
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

# ── Linting ─────────────────────────────────────────────────────
[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM", "ANN"]
ignore = ["ANN101", "ANN102"]

[tool.pyright]
pythonVersion = "3.12"
typeCheckingMode = "strict"
```

> **Architect note**: `uuid-utils` is the correct library for UUIDv7 — not `uuid` stdlib.
> The monolith has ONE `pyproject.toml`. The worker has its own separate one.
> `aioboto3` (not `boto3`) is used in the API because every endpoint is `async`.

---

### `worker/pyproject.toml`

```toml
[project]
name = "rithm-worker"
version = "0.1.0"
requires-python = ">=3.11"        # 3.11 for best PyTorch 2.3 compat
dependencies = [
    "structlog>=24.1",
    "boto3>=1.34",
    "sqlalchemy>=2.0",            # sync only — worker is not async
    "psycopg2-binary>=2.9",
    "pydantic-settings>=2.3",
    "uuid-utils>=0.9",
]

# GPU deps are an optional group so CI can install without CUDA
[dependency-groups]
gpu = [
    "torch>=2.3",
    "torchaudio>=2.3",
    # "transformers>=4.41",       # uncomment when ACE-Step API is confirmed
    # "accelerate>=0.30",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.uv]
dev-dependencies = [
    "pytest>=8.2",
    "ruff>=0.5",
    "pyright>=1.1",
]

[tool.uv.sources]
torch = { index = "pytorch-cu121" }
torchaudio = { index = "pytorch-cu121" }

[[tool.uv.index]]
name = "pytorch-cu121"
url = "https://download.pytorch.org/whl/cu121"
explicit = true

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = ["gpu: requires NVIDIA GPU (skip in CI)"]
```

> **Architect note**: Worker uses **sync** SQLAlchemy (`psycopg2`) — not async.
> The worker is a long-running batch process, not a web server. Async adds zero value here
> and complicates SIGTERM handling. GPU dependencies are optional so `uv sync --no-group gpu`
> works in CI without a CUDA environment.

---

### `web/package.json`

```json
{
  "name": "rithm-web",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "lint": "eslint . --ext ts,tsx --max-warnings 0",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "a11y": "pa11y-ci"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.23.0",
    "@tanstack/react-query": "^5.40.0",
    "zustand": "^4.5.2",
    "@aws-amplify/auth": "^6.3.0",
    "event-source-polyfill": "^1.0.31",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.3.0",
    "lucide-react": "^0.383.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/event-source-polyfill": "^1.0.5",
    "@typescript-eslint/eslint-plugin": "^7.13.0",
    "@typescript-eslint/parser": "^7.13.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.19",
    "eslint": "^8.57.0",
    "eslint-plugin-jsx-a11y": "^6.8.0",
    "eslint-plugin-react-hooks": "^4.6.2",
    "pa11y-ci": "^3.1.0",
    "@playwright/test": "^1.44.0",
    "postcss": "^8.4.39",
    "tailwindcss": "^3.4.4",
    "typescript": "^5.5.2",
    "vite": "^5.3.1",
    "vitest": "^1.6.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.5.2",
    "@vitest/ui": "^1.6.0"
  }
}
```

> **Note**: shadcn/ui components are generated via `npx shadcn@latest add <component>`,
> not imported as a package. The `@radix-ui/*` packages are added automatically
> by the CLI when components are installed. Do NOT add them manually to this file.

---

### `docker-compose.yml`

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: rithm
      POSTGRES_USER: rithm_admin
      POSTGRES_PASSWORD: dev_admin_pw_change_me
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./ops/scripts/init-db-users.sql:/docker-entrypoint-initdb.d/01-init-users.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rithm_admin -d rithm"]
      interval: 5s
      timeout: 5s
      retries: 10

  localstack:
    image: localstack/localstack:3
    restart: unless-stopped
    ports:
      - "4566:4566"
    environment:
      SERVICES: sqs,sns,s3
      DEFAULT_REGION: us-east-1
      EAGER_SERVICE_LOADING: 1
    volumes:
      - localstackdata:/var/lib/localstack
      - ./ops/scripts/init-localstack.sh:/etc/localstack/init/ready.d/10-init-resources.sh:ro
    healthcheck:
      test: ["CMD-SHELL", "curl -s http://localhost:4566/_localstack/health | grep -q '\"sqs\": \"running\"'"]
      interval: 10s
      timeout: 10s
      retries: 10

  api:
    build:
      context: ./api
      target: development
    restart: unless-stopped
    ports:
      - "8080:8080"
    env_file:
      - .env.local             # gitignored; copy from .env.example
    environment:
      # Override for local docker-compose networking
      AWS_ENDPOINT_URL: http://localstack:4566
      AWS_ACCESS_KEY_ID: test
      AWS_SECRET_ACCESS_KEY: test
      AWS_DEFAULT_REGION: us-east-1
      DB_IDENTITY_DSN: postgresql+asyncpg://rithm_identity:dev_identity_pw@postgres:5432/rithm
      DB_CATALOG_DSN: postgresql+asyncpg://rithm_catalog:dev_catalog_pw@postgres:5432/rithm
      DB_GENERATION_DSN: postgresql+asyncpg://rithm_generation:dev_generation_pw@postgres:5432/rithm
      DB_CONVERSATION_DSN: postgresql+asyncpg://rithm_conversation:dev_conversation_pw@postgres:5432/rithm
      DB_PERSONALIZATION_DSN: postgresql+asyncpg://rithm_personalization:dev_personalization_pw@postgres:5432/rithm
      ASSETS_BUCKET: rithm-assets-local
      SQS_JOBS_QUEUE_URL: http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/rithm-generation-jobs
      SNS_COMPLETIONS_TOPIC_ARN: arn:aws:sns:us-east-1:000000000000:rithm-job-completions
      ENVIRONMENT: local
      LOG_LEVEL: DEBUG
    volumes:
      - ./api/app:/app/app     # hot-reload in dev only (target: development)
    depends_on:
      postgres:
        condition: service_healthy
      localstack:
        condition: service_healthy

  # ── Worker is intentionally NOT in docker-compose ──────────────────────────
  # The worker requires a GPU (NVIDIA T4/A10G) and runs on EC2 spot.
  # Local testing of the generation pipeline uses a dev shortcut:
  # a fake SNS completion message posted via the ops/scripts/fake-complete-job.sh script.

volumes:
  pgdata:
  localstackdata:
```

> **Critical architecture note**: The worker is absent from docker-compose deliberately.
> Local end-to-end generation tests work by directly posting a fake SNS completion
> message to the `/internal/sns/job-completion` endpoint after submitting a job.
> Attempting to run the worker locally (CPU mode) produces meaningless audio and slows
> development. The PoC on Day 5 is the only time the worker runs outside ECS.

---

### `ops/scripts/init-localstack.sh`

```bash
#!/usr/bin/env bash
# Runs inside LocalStack container on startup via the init hooks directory.
# Creates all AWS resources needed for local development.
set -euo pipefail

echo "[LocalStack Init] Creating S3 buckets..."
awslocal s3 mb s3://rithm-assets-local
awslocal s3 mb s3://rithm-web-local

echo "[LocalStack Init] Creating SQS queues..."
awslocal sqs create-queue \
  --queue-name rithm-generation-jobs-dlq \
  --attributes MessageRetentionPeriod=1209600

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/rithm-generation-jobs-dlq" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue \
  --queue-name rithm-generation-jobs \
  --attributes "{
    \"VisibilityTimeout\": \"300\",
    \"MessageRetentionPeriod\": \"345600\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
  }"

awslocal sqs create-queue --queue-name rithm-sns-completions-dlq

echo "[LocalStack Init] Creating SNS topics..."
awslocal sns create-topic --name rithm-job-completions
awslocal sns create-topic --name rithm-job-completions-dlq

echo "[LocalStack Init] Done. Resources ready."
```

---

### `ops/scripts/init-db-users.sql`

This file is mounted into the Postgres container's `docker-entrypoint-initdb.d/` directory.
It runs **once** at first container start. If you reset state, do `docker-compose down -v`.

```sql
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
```

---

### `.env.example` (root level)

```bash
# Copy to .env.local and fill in values. .env.local is gitignored.

# Local dev uses docker-compose networking, so these are overridden
# in docker-compose.yml environment block.
# This file is for running api/ outside docker (e.g. `uvicorn app.main:app` directly).

ENVIRONMENT=local
LOG_LEVEL=DEBUG

# DB — per-module DSNs (local dev)
DB_IDENTITY_DSN=postgresql+asyncpg://rithm_identity:dev_identity_pw@localhost:5432/rithm
DB_CATALOG_DSN=postgresql+asyncpg://rithm_catalog:dev_catalog_pw@localhost:5432/rithm
DB_GENERATION_DSN=postgresql+asyncpg://rithm_generation:dev_generation_pw@localhost:5432/rithm
DB_CONVERSATION_DSN=postgresql+asyncpg://rithm_conversation:dev_conversation_pw@localhost:5432/rithm
DB_PERSONALIZATION_DSN=postgresql+asyncpg://rithm_personalization:dev_personalization_pw@localhost:5432/rithm

# AWS (LocalStack for local dev)
AWS_ENDPOINT_URL=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_DEFAULT_REGION=us-east-1
ASSETS_BUCKET=rithm-assets-local
SQS_JOBS_QUEUE_URL=http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/rithm-generation-jobs
SNS_COMPLETIONS_TOPIC_ARN=arn:aws:sns:us-east-1:000000000000:rithm-job-completions

# Cognito (use real dev pool even in local dev — LocalStack Cognito coverage is incomplete)
COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
COGNITO_APP_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx

# Operational
SSE_TOKEN_SECRET=local-dev-secret-not-for-prod
CURRENT_CONSENT_VERSION=tos-2026-05
```

---

## Day 1 Exit Gate

```bash
# Gate 1: docker-compose starts cleanly
docker-compose up -d --wait
docker-compose ps           # all services "healthy"

# Gate 2: LocalStack resources exist
docker-compose exec localstack awslocal sqs list-queues
# expects: rithm-generation-jobs, rithm-generation-jobs-dlq

# Gate 3: Postgres schemas exist
docker-compose exec postgres psql -U rithm_admin -d rithm \
  -c "\dn"
# expects: identity, catalog, generation, conversation, personalization

# Gate 4: Python package resolves
cd api && uv sync --frozen && uv run python -c "import app; print('ok')"
cd ../worker && uv sync --no-group gpu && uv run python -c "import worker; print('ok')"
```

---

---

## DAY 2 — DDL + API Foundation

**Goal**: Complete Postgres DDL with Alembic applied to local DB. FastAPI app factory
with all middleware wired. `config.py` with all env vars. `/health` returning 200.

---

### `api/app/config.py`

```python
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Runtime environment
    environment: str = "local"   # local | prod — drives SSL, docs visibility, etc.

    # Database — one DSN per bounded-context module
    # Format: postgresql+asyncpg://user:pw@host:port/dbname
    db_identity_dsn: SecretStr
    db_catalog_dsn: SecretStr
    db_generation_dsn: SecretStr
    db_conversation_dsn: SecretStr
    db_personalization_dsn: SecretStr

    # AWS infrastructure
    aws_region: str = "us-east-1"
    aws_endpoint_url: str | None = None   # set to LocalStack URL in local/test envs
    assets_bucket: str
    sqs_jobs_queue_url: str
    sns_completions_topic_arn: str
    cloudfront_distribution_domain: str = ""
    cloudfront_signing_key_pair_id: str = ""
    cloudfront_signing_key: SecretStr = SecretStr("")

    # Cognito
    cognito_user_pool_id: str = ""
    cognito_app_client_id: str = ""

    # Bedrock + OpenAI
    bedrock_haiku_model_id: str = "anthropic.claude-3-haiku-20240307-v1:0"
    openai_api_key: SecretStr = SecretStr("")

    # Operational knobs
    log_level: str = "INFO"
    sse_token_ttl_seconds: int = 300
    sse_token_secret: SecretStr = SecretStr("dev-sse-secret-change-me")
    rate_limit_per_24h: int = 20
    stuck_job_timeout_minutes: int = 10

    # Consent
    current_consent_version: str = "tos-2026-05"


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

> **Important**: `lru_cache` makes `get_settings()` a singleton per process.
> In tests, call `get_settings.cache_clear()` between tests that mutate env vars.
> Never call `Settings()` directly — always use `get_settings()`.

---

### `api/app/shared/db.py`

**Architectural contract**: Every module gets its own `AsyncEngine` and `async_sessionmaker`.
No module may use another module's session. This is the physical enforcement of bounded
contexts at the Python layer (backed by DB-level permission grants).

```python
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from contextlib import asynccontextmanager
from typing import AsyncGenerator
import structlog

logger = structlog.get_logger()

_engines: dict[str, AsyncEngine] = {}
_session_factories: dict[str, async_sessionmaker[AsyncSession]] = {}

# Maps module name → lambda that extracts the DSN from Settings
_MODULE_DSN_GETTERS: dict[str, str] = {
    "identity": "db_identity_dsn",
    "catalog": "db_catalog_dsn",
    "generation": "db_generation_dsn",
    "conversation": "db_conversation_dsn",
    "personalization": "db_personalization_dsn",
}


def init_db_engines() -> None:
    """
    Call once from FastAPI lifespan (startup).
    Creates one AsyncEngine + sessionmaker per module.
    """
    from app.config import get_settings
    settings = get_settings()

    for module, dsn_field in _MODULE_DSN_GETTERS.items():
        dsn = getattr(settings, dsn_field).get_secret_value()

        connect_args: dict = {}
        if settings.environment == "prod":
            connect_args["ssl"] = "require"

        engine = create_async_engine(
            dsn,
            pool_size=5,
            max_overflow=5,
            pool_pre_ping=True,
            connect_args=connect_args,
        )
        _engines[module] = engine
        _session_factories[module] = async_sessionmaker(
            engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )
        logger.info("db_engine_created", module=module)


async def close_db_engines() -> None:
    """Call from FastAPI lifespan (shutdown)."""
    for module, engine in _engines.items():
        await engine.dispose()
        logger.info("db_engine_disposed", module=module)


@asynccontextmanager
async def get_session(module: str) -> AsyncGenerator[AsyncSession, None]:
    """
    Async context manager that yields a module-scoped DB session.

    Usage (inside a service function):
        async with get_session("identity") as session:
            result = await session.execute(select(User).where(...))

    Automatically commits on success, rolls back on exception.
    """
    if module not in _session_factories:
        raise RuntimeError(
            f"DB engine for module '{module}' not initialized. "
            "Was init_db_engines() called at startup?"
        )
    factory = _session_factories[module]
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
```

---

### `api/app/shared/logging.py`

```python
import logging
import structlog
from structlog.typing import EventDict, WrappedLogger

# Keys whose values must NEVER appear in logs
_SENSITIVE_KEYS = frozenset({
    "password", "id_token", "refresh_token", "api_key",
    "authorization", "access_key", "secret_key",
    "cognito_sub", "openai_api_key",
})


def _scrub_sensitive(
    _logger: WrappedLogger, _method: str, event_dict: EventDict
) -> EventDict:
    for key in list(event_dict.keys()):
        if key.lower() in _SENSITIVE_KEYS:
            event_dict[key] = "**REDACTED**"
    return event_dict


def configure_logging(log_level: str = "INFO") -> None:
    level = getattr(logging, log_level.upper(), logging.INFO)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.stdlib.add_logger_name,
            structlog.processors.TimeStamper(fmt="iso"),
            _scrub_sensitive,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
```

---

### `api/app/shared/exceptions.py`

All custom exceptions are `HTTPException` subclasses so FastAPI's exception handler
picks them up automatically.

```python
from fastapi import HTTPException
from typing import Any


class RateLimitExceededException(HTTPException):
    def __init__(self, retry_after_seconds: int, used: int, limit: int) -> None:
        super().__init__(
            status_code=429,
            detail=(
                f"You have used {used} of {limit} generations in the last 24h. "
                f"Try again in {retry_after_seconds} seconds."
            ),
            headers={"Retry-After": str(retry_after_seconds)},
        )


class ResourceNotFoundException(HTTPException):
    def __init__(self, resource: str, resource_id: str) -> None:
        super().__init__(
            status_code=404,
            detail=f"{resource} '{resource_id}' not found or access denied.",
        )


class UpstreamServiceException(HTTPException):
    def __init__(self, service: str, retry_after_seconds: int = 30) -> None:
        super().__init__(
            status_code=502,
            detail=f"Upstream service '{service}' is temporarily unavailable. Please retry.",
            headers={"Retry-After": str(retry_after_seconds)},
        )


class ConflictException(HTTPException):
    def __init__(self, detail: str) -> None:
        super().__init__(status_code=409, detail=detail)


class ForbiddenException(HTTPException):
    def __init__(self, detail: str = "Insufficient permissions.") -> None:
        super().__init__(status_code=403, detail=detail)
```

---

### `api/app/middleware/request_id.py`

```python
import uuid
import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get("X-Request-Id") or str(uuid.uuid4())
        # Bind to structlog contextvars — available on all log lines in this request
        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            response: Response = await call_next(request)
            response.headers["X-Request-Id"] = request_id
            return response
        finally:
            structlog.contextvars.unbind_contextvars("request_id")
```

---

### `api/app/middleware/error_handler.py`

RFC 7807 Problem+JSON format for ALL non-2xx responses. No exception escapes as HTML.

```python
import structlog
from fastapi import FastAPI, Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = structlog.get_logger()


def _problem(
    status: int, title: str, request: Request, detail: object | None = None
) -> dict:
    return {
        "type": f"https://rithm.dev/errors/{status}",
        "title": title,
        "status": status,
        "detail": detail,
        "instance": str(request.url.path),
        "request_id": structlog.contextvars.get_contextvars().get("request_id", ""),
    }


def register_error_handlers(app: FastAPI) -> None:

    @app.exception_handler(HTTPException)
    async def http_exception_handler(
        request: Request, exc: HTTPException
    ) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_problem(exc.status_code, exc.detail, request),
            headers=dict(exc.headers) if exc.headers else {},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=_problem(422, "Validation Error", request, detail=exc.errors()),
        )

    @app.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception(
            "unhandled_error",
            event_type="error.5xx",
            error_class=type(exc).__name__,
            error=str(exc),
        )
        return JSONResponse(
            status_code=500,
            content=_problem(500, "Internal Server Error", request),
        )
```

---

### `api/app/middleware/cors.py`

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


def setup_cors(app: FastAPI) -> None:
    from app.config import get_settings
    settings = get_settings()

    # In prod, restrict to the CloudFront domain only.
    # In local/test, allow localhost origins.
    if settings.environment == "prod":
        origins = [f"https://{settings.cloudfront_distribution_domain}"]
    else:
        origins = [
            "http://localhost:5173",  # vite dev server
            "http://localhost:3000",
        ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-Id"],
        expose_headers=["X-Request-Id", "X-Total-Count", "Link", "Retry-After"],
    )
```

---

### `api/app/main.py`

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
import structlog

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ────────────────────────────────────────────────
    from app.config import get_settings
    from app.shared.logging import configure_logging
    from app.shared.db import init_db_engines

    settings = get_settings()
    configure_logging(settings.log_level)
    init_db_engines()

    logger.info(
        "startup_complete",
        environment=settings.environment,
        version="0.1.0",
    )
    yield

    # ── Shutdown ───────────────────────────────────────────────
    from app.shared.db import close_db_engines
    await close_db_engines()
    logger.info("shutdown_complete")


def create_app() -> FastAPI:
    from app.config import get_settings
    from app.middleware.cors import setup_cors
    from app.middleware.request_id import RequestIdMiddleware
    from app.middleware.error_handler import register_error_handlers

    settings = get_settings()

    app = FastAPI(
        title="RITHM API",
        version="0.1.0",
        # Disable /docs in prod — the OpenAPI spec is for internal use only
        docs_url="/docs" if settings.environment != "prod" else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.environment != "prod" else None,
        lifespan=lifespan,
    )

    setup_cors(app)
    app.add_middleware(RequestIdMiddleware)
    register_error_handlers(app)

    # ── Health (no auth required) ──────────────────────────────
    @app.get("/health", tags=["ops"], include_in_schema=False)
    async def health() -> dict:
        return {"status": "ok", "version": "0.1.0"}

    # ── Routers — added as modules are implemented (Days 6–33) ─
    # from app.modules.identity.api import router as identity_router
    # app.include_router(identity_router, prefix="/api/v1")
    # ... etc.

    return app


app = create_app()
```

---

### `api/app/shared/sns_verify.py`

SNS delivers its HTTPS subscription confirmation and job-completion messages
with a signature that MUST be verified before trusting the payload.
This module implements the verification chain.

```python
"""
SNS message signature verification per AWS documentation.
Called by the /internal/sns/job-completion endpoint.
Ref: https://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.verify.signature.html
"""
import base64
import hashlib
import re
import urllib.request
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.x509 import load_pem_x509_certificate
import structlog

logger = structlog.get_logger()

# Allowlist for SigningCertURL domains — reject anything else
_VALID_CERT_DOMAINS = re.compile(
    r"^https://sns\.[a-z0-9\-]+\.amazonaws\.com/"
)

_cert_cache: dict[str, bytes] = {}


def _fetch_cert(url: str) -> bytes:
    if not _VALID_CERT_DOMAINS.match(url):
        raise ValueError(f"Suspicious SigningCertURL domain: {url}")
    if url not in _cert_cache:
        with urllib.request.urlopen(url, timeout=5) as r:
            _cert_cache[url] = r.read()
    return _cert_cache[url]


def _build_message_to_sign(payload: dict) -> bytes:
    """
    Reconstruct the canonical string that SNS signs.
    Field order and presence differ by message Type.
    """
    msg_type = payload.get("Type", "")
    if msg_type == "Notification":
        fields = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
    else:
        # SubscriptionConfirmation / UnsubscribeConfirmation
        fields = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]

    parts: list[str] = []
    for field in fields:
        if field in payload:
            parts.append(field)
            parts.append(payload[field])
    return "\n".join(parts).encode("utf-8") + b"\n"


def verify_sns_signature(payload: dict) -> None:
    """
    Verify an SNS message's signature. Raises ValueError on failure.
    Must be called before trusting any payload from /internal/sns/*.
    """
    cert_url = payload.get("SigningCertURL", "")
    signature_b64 = payload.get("Signature", "")

    cert_pem = _fetch_cert(cert_url)
    cert = load_pem_x509_certificate(cert_pem)
    public_key = cert.public_key()

    signature = base64.b64decode(signature_b64)
    message = _build_message_to_sign(payload)

    try:
        public_key.verify(signature, message, padding.PKCS1v15(), hashes.SHA1())
    except Exception as e:
        logger.warning(
            "sns_signature_invalid",
            event_type="sns.signature.invalid",
            cert_url=cert_url,
            error=str(e),
        )
        raise ValueError("SNS signature verification failed") from e
```

---

### Alembic setup — per-module pattern

All 5 modules follow the same pattern. Shown once for `identity`; replicate for the rest.

**`api/migrations/identity/alembic.ini`**:
```ini
[alembic]
script_location = migrations/identity
prepend_sys_path = .
version_table = alembic_version
version_table_schema = identity

[loggers]
keys = root,sqlalchemy,alembic
[handlers]
keys = console
[formatters]
keys = generic

[logger_root]
level = WARNING
handlers = console
qualname =

[logger_sqlalchemy]
level = WARNING
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
```

**`api/migrations/identity/env.py`**:
```python
from alembic import context
from sqlalchemy import engine_from_config, pool
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from app.config import get_settings

config = context.config
settings = get_settings()
DSN = settings.db_identity_dsn.get_secret_value()


def run_migrations_offline() -> None:
    context.configure(
        url=DSN,
        target_metadata=None,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_schemas=True,
        version_table_schema="identity",
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        {"sqlalchemy.url": DSN.replace("+asyncpg", "")},  # use sync driver for alembic
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=None,
            include_schemas=True,
            version_table_schema="identity",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

> **Critical**: `DSN.replace("+asyncpg", "")` converts the async DSN format to sync
> for Alembic's `engine_from_config`. Alembic runs synchronously — it cannot use asyncpg.
> Replicate this pattern exactly for all 5 modules, substituting the DSN field name.

---

### Day 2 baseline migration — `api/migrations/identity/versions/0001_baseline.py`

One baseline migration per module containing the CREATE TABLE statements.
The identity module's baseline:

```python
"""identity schema baseline

Revision ID: 0001_identity_baseline
Revises:
Create Date: 2026-06-03
"""
from alembic import op

revision = "0001_identity_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS identity.users (
            id                   UUID         NOT NULL PRIMARY KEY,
            cognito_sub          VARCHAR(64)  NOT NULL UNIQUE,
            email                VARCHAR(320) NOT NULL UNIQUE,
            email_verified       BOOLEAN      NOT NULL DEFAULT TRUE,
            mfa_enabled          BOOLEAN      NOT NULL DEFAULT FALSE,
            is_admin             BOOLEAN      NOT NULL DEFAULT FALSE,
            consent_accepted_at  TIMESTAMPTZ,
            consent_version      VARCHAR(16),
            created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
            updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
        )
    """)
    op.execute("""
        CREATE TRIGGER users_touch
        BEFORE UPDATE ON identity.users
        FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS identity.users")
```

> Create equivalent baseline migrations for all 5 modules using the exact DDL from §5.1
> of the design doc. Each module's baseline migration contains only that module's tables.
> The `public.touch_updated_at()` function is created by `init-db-users.sql` at DB init
> time — migrations assume it exists.

---

### `ops/scripts/run-migrations.sh`

```bash
#!/usr/bin/env bash
# Runs all module Alembic migrations in dependency order.
# Called by:
#   1. GitHub Actions deploy-api.yml (before ECS service update)
#   2. One-off Fargate task in prod for manual migration runs
#   3. Local dev: `bash ops/scripts/run-migrations.sh`
set -euo pipefail

MODULES=("identity" "catalog" "generation" "conversation" "personalization")

cd "$(dirname "$0")/../.."    # repo root

echo "=== Running RITHM DB migrations ==="
for module in "${MODULES[@]}"; do
    echo "--- Module: $module ---"
    cd api
    uv run alembic -c "migrations/${module}/alembic.ini" upgrade head
    cd ..
    echo "--- Module $module: OK ---"
done

echo "=== All migrations complete ==="
```

---

### `api/tests/conftest.py`

```python
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport
from app.main import app


@pytest.fixture
def sync_client():
    with TestClient(app) as client:
        yield client


@pytest_asyncio.fixture
async def async_client():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client
```

### `api/tests/test_health.py`

```python
import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_returns_200(async_client: AsyncClient) -> None:
    response = await async_client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "version" in body


@pytest.mark.asyncio
async def test_health_has_request_id_header(async_client: AsyncClient) -> None:
    response = await async_client.get("/health")
    assert "x-request-id" in response.headers


@pytest.mark.asyncio
async def test_404_returns_problem_json(async_client: AsyncClient) -> None:
    response = await async_client.get("/nonexistent-path")
    assert response.status_code == 404
    body = response.json()
    assert "type" in body
    assert "title" in body
    assert "status" in body
    assert body["status"] == 404
```

---

## Day 2 Exit Gate

```bash
# Gate 1: Migrations run cleanly on local DB
bash ops/scripts/run-migrations.sh
# expects: "All migrations complete"

# Gate 2: All tables exist
docker-compose exec postgres psql -U rithm_admin -d rithm \
  -c "\dt identity.* catalog.* generation.* conversation.* personalization.*"

# Gate 3: API health check
curl -s http://localhost:8080/health | jq .
# expects: {"status":"ok","version":"0.1.0"}

# Gate 4: /health has X-Request-Id header
curl -v http://localhost:8080/health 2>&1 | grep -i x-request-id

# Gate 5: Tests pass
cd api && uv run pytest tests/test_health.py -v
```

---

---

## DAY 3 — CI/CD + Dockerfiles

**Goal**: All GitHub Actions workflows green on a hello-world commit. API + Worker
Docker images build locally. `api/Dockerfile` production stage produces < 500 MB image.

---

### `api/Dockerfile`

```dockerfile
# ─── Stage 1: Python dependency resolver ──────────────────────
FROM python:3.12-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-dev --no-editable

# ─── Stage 2: Development (hot-reload via volume mount) ────────
FROM python:3.12-slim AS development

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/.venv ./.venv
ENV PATH="/app/.venv/bin:$PATH"

# Install with dev deps for hot-reload
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen

COPY app/ ./app/
COPY migrations/ ./migrations/

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--reload"]

# ─── Stage 3: Production ──────────────────────────────────────
FROM python:3.12-slim AS production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/.venv ./.venv
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY app/ ./app/
COPY migrations/ ./migrations/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8080/health || exit 1

# Single worker — horizontal scaling handled by ECS desiredCount, not Gunicorn
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
```

### `api/.dockerignore`

```
.venv/
__pycache__/
*.py[cod]
.pytest_cache/
.mypy_cache/
.ruff_cache/
tests/
.env
.env.*
*.md
```

---

### `worker/Dockerfile`

Multi-stage: Stage 1 fetches model weights from HuggingFace; Stage 2 is the GPU runtime.

```dockerfile
# ─── Stage 1: Weight Fetcher ──────────────────────────────────
FROM python:3.11-slim AS weight-fetcher

RUN pip install --no-cache-dir huggingface_hub

# Developer must supply HF_TOKEN if ACE-Step v1.5 is gated.
# Build with: docker build --build-arg HF_TOKEN=$HF_TOKEN ...
ARG HF_TOKEN=""
ENV HUGGING_FACE_HUB_TOKEN=$HF_TOKEN

WORKDIR /weights
RUN python - <<'EOF'
from huggingface_hub import snapshot_download
import sys

try:
    snapshot_download(
        repo_id="ACE-Step/ACE-Step-v1.5",
        local_dir="/weights/acestep",
        ignore_patterns=["*.bin"],    # prefer safetensors over bin
    )
    print("Weights downloaded successfully", flush=True)
except Exception as e:
    print(f"ERROR downloading weights: {e}", flush=True)
    sys.exit(1)
EOF

# ─── Stage 2: GPU Runtime ─────────────────────────────────────
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3-pip \
    python3.11-dev \
    python3.11-distutils \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# PyTorch 2.3 with CUDA 12.1 wheels
RUN pip install --no-cache-dir \
    "torch>=2.3.0" \
    "torchaudio>=2.3.0" \
    --extra-index-url https://download.pytorch.org/whl/cu121

# Project deps (no GPU group needed — torch already installed above)
RUN pip install --no-cache-dir uv
WORKDIR /app
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-dev --no-group gpu

# Copy baked model weights from Stage 1 (~5–8 GB)
COPY --from=weight-fetcher /weights/acestep/ /opt/acestep/weights/

# Worker source
COPY worker/ ./worker/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_WEIGHTS_PATH=/opt/acestep/weights

# No HEALTHCHECK — worker is a queue consumer, not an HTTP server.
# ECS monitors the task's exit code instead.
CMD ["python", "-m", "worker.main"]
```

> **Build note**: First build is slow (~30–60 min) due to weight download + PyTorch.
> Subsequent builds that hit the layer cache are ~2 min.
> For CI, the worker image is built only on pushes to `worker/`, using `--cache-from` to
> avoid re-downloading weights on every build.

---

### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  # ── API: lint, typecheck, import-linter, tests ───────────────
  api-ci:
    name: API CI
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: rithm_test
          POSTGRES_USER: rithm_admin
          POSTGRES_PASSWORD: ci_admin_pw
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready
          --health-interval 5s --health-timeout 5s --health-retries 10

    defaults:
      run:
        working-directory: api/

    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v4

      - name: Install dependencies
        run: uv sync --frozen

      - name: Lint (ruff)
        run: uv run ruff check . && uv run ruff format --check .

      - name: Type check (pyright)
        run: uv run pyright

      - name: Check module boundaries (import-linter)
        run: uv run lint-imports

      - name: Run tests
        env:
          ENVIRONMENT: test
          # All modules point at same DB with same user in CI for simplicity.
          # Per-module isolation is enforced by the import-linter, not DB grants in CI.
          DB_IDENTITY_DSN: postgresql+asyncpg://rithm_admin:ci_admin_pw@localhost:5432/rithm_test
          DB_CATALOG_DSN: postgresql+asyncpg://rithm_admin:ci_admin_pw@localhost:5432/rithm_test
          DB_GENERATION_DSN: postgresql+asyncpg://rithm_admin:ci_admin_pw@localhost:5432/rithm_test
          DB_CONVERSATION_DSN: postgresql+asyncpg://rithm_admin:ci_admin_pw@localhost:5432/rithm_test
          DB_PERSONALIZATION_DSN: postgresql+asyncpg://rithm_admin:ci_admin_pw@localhost:5432/rithm_test
          ASSETS_BUCKET: ci-assets-bucket
          SQS_JOBS_QUEUE_URL: http://localhost:4566/000000000000/rithm-generation-jobs
          SNS_COMPLETIONS_TOPIC_ARN: arn:aws:sns:us-east-1:000000000000:rithm-job-completions
        run: uv run pytest -q --tb=short

      - name: Migration dry-run (SQL diff as PR comment)
        env:
          DB_IDENTITY_DSN: postgresql+asyncpg://rithm_admin:ci_admin_pw@localhost:5432/rithm_test
          # ... (same as above)
        run: |
          for module in identity catalog generation conversation personalization; do
            echo "--- $module ---"
            uv run alembic -c "migrations/${module}/alembic.ini" upgrade head --sql
          done

  # ── Web: lint, typecheck, unit tests ─────────────────────────
  web-ci:
    name: Web CI
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web/
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: web/package-lock.json

      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test

  # ── Worker: lint, typecheck, unit tests (no GPU) ─────────────
  worker-ci:
    name: Worker CI
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: worker/
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v4

      - name: Install (no GPU deps)
        run: uv sync --frozen --no-dev --no-group gpu

      - name: Lint
        run: uv run ruff check .

      - name: Type check
        run: uv run pyright

      - name: Tests (skip GPU-marked tests)
        run: uv run pytest -q -m "not gpu" --tb=short
```

---

### `.github/workflows/deploy-api.yml`

```yaml
name: Deploy API

on:
  push:
    branches: [main]
    paths: ["api/**", "ops/scripts/run-migrations.sh"]

permissions:
  id-token: write   # OIDC token for AWS auth
  contents: read

env:
  AWS_REGION: us-east-1
  ECR_REPO: rithm/api
  ECS_CLUSTER: rithm-prod
  ECS_SERVICE: rithm-api

jobs:
  deploy:
    name: Build, Migrate, Deploy
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC — no long-lived keys)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: ecr-login
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push API image
        env:
          REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          TAG: ${{ github.sha }}
        run: |
          docker buildx build \
            --platform linux/amd64 \
            --target production \
            -t $REGISTRY/$ECR_REPO:$TAG \
            -t $REGISTRY/$ECR_REPO:latest \
            --push \
            api/

      - name: Run DB migrations (forward-only)
        # Runs as a one-off Fargate task using the NEW image before service swap.
        # If migrations fail, the service is NOT updated (last-good preserved).
        env:
          REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          TAG: ${{ github.sha }}
        run: |
          aws ecs run-task \
            --cluster ${{ env.ECS_CLUSTER }} \
            --task-definition rithm-api-migrations \
            --overrides "{\"containerOverrides\":[{
              \"name\":\"api\",
              \"image\":\"$REGISTRY/$ECR_REPO:$TAG\",
              \"command\":[\"bash\",\"ops/scripts/run-migrations.sh\"]
            }]}" \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[${{ secrets.PRIVATE_SUBNET_IDS }}],securityGroups=[${{ secrets.API_SG_ID }}]}"
          # Wait for migration task to complete successfully before continuing

      - name: Register new task definition
        env:
          REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          TAG: ${{ github.sha }}
        run: |
          NEW_TASKDEF=$(cat ops/task-definitions/api.json.template \
            | jq --arg img "$REGISTRY/$ECR_REPO:$TAG" \
                '.containerDefinitions[0].image = $img')
          aws ecs register-task-definition --cli-input-json "$NEW_TASKDEF"

      - name: Update ECS service (rolling deploy)
        run: |
          REVISION=$(aws ecs describe-task-definition \
            --task-definition rithm-api \
            --query 'taskDefinition.revision' --output text)
          aws ecs update-service \
            --cluster ${{ env.ECS_CLUSTER }} \
            --service ${{ env.ECS_SERVICE }} \
            --task-definition rithm-api:$REVISION
          aws ecs wait services-stable \
            --cluster ${{ env.ECS_CLUSTER }} \
            --services ${{ env.ECS_SERVICE }}
          echo "Deploy complete: rithm-api:$REVISION"
```

### `.github/workflows/deploy-web.yml`

```yaml
name: Deploy Web

on:
  push:
    branches: [main]
    paths: ["web/**"]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web/
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: web/package-lock.json

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1

      - run: npm ci
      - run: npm run build

      - name: Sync to S3
        run: |
          aws s3 sync dist/ s3://rithm-web-prod/ \
            --delete \
            --cache-control "public,max-age=31536000,immutable" \
            --exclude "index.html"
          # index.html: no-cache so users always get latest SPA shell
          aws s3 cp dist/index.html s3://rithm-web-prod/index.html \
            --cache-control "no-cache,no-store,must-revalidate"

      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ secrets.CF_DIST_ID }} \
            --paths "/*"
```

### `.github/workflows/deploy-worker.yml`

```yaml
name: Deploy Worker

on:
  push:
    branches: [main]
    paths: ["worker/**"]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest   # large runner recommended for 12GB image
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1

      - name: Login to ECR
        id: ecr-login
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push worker image (with ECR layer cache)
        env:
          REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          TAG: ${{ github.sha }}
        run: |
          # Pull latest for layer cache — avoids re-downloading 8GB weights on every push
          docker pull $REGISTRY/rithm/worker:latest || true
          docker buildx build \
            --platform linux/amd64 \
            --cache-from $REGISTRY/rithm/worker:latest \
            --build-arg HF_TOKEN=${{ secrets.HF_TOKEN }} \
            -t $REGISTRY/rithm/worker:$TAG \
            -t $REGISTRY/rithm/worker:latest \
            --push \
            worker/

      - name: Register new task definition
        env:
          REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          TAG: ${{ github.sha }}
        run: |
          NEW_TASKDEF=$(cat ops/task-definitions/worker.json.template \
            | jq --arg img "$REGISTRY/rithm/worker:$TAG" \
                '.containerDefinitions[0].image = $img')
          aws ecs register-task-definition --cli-input-json "$NEW_TASKDEF"
          echo "Worker task definition updated. Service picks up new image on next scale-up."
```

> **Deployment order matters**: Migrations run BEFORE the ECS service swap.
> If migrations fail, the deploy aborts and the old image keeps serving.
> This is the "forward-only migrations" safety guarantee.

---

## Day 3 Exit Gate

```bash
# Gate 1: API image builds
cd api && docker build --target production -t rithm-api:test . && docker images rithm-api:test

# Gate 2: API image is < 500 MB
docker images rithm-api:test --format "{{.Size}}"

# Gate 3: Worker image builds (minus real weights — stub weights dir)
cd ../worker
mkdir -p /tmp/stub-weights && touch /tmp/stub-weights/stub.txt
# Build with ARG override pointing to stub weights:
docker build --target production \
  --build-arg HF_TOKEN="" \
  -t rithm-worker:test .

# Gate 4: Create a PR branch and verify CI workflow triggers
git checkout -b test/ci-smoke
echo "# test" >> README.md
git commit -am "ci smoke test"
git push origin test/ci-smoke
# Open PR → verify ci.yml runs all 3 jobs
```

---

---

## DAY 4 — Observability + Health Hardening

**Goal**: Structured JSON logs on every request with `request_id`. EMF metrics wired.
All CloudWatch alarm definitions in JSON. All 9 runbook stubs populated. `/health`
tested through the CloudFront → ALB → Fargate path (requires Day 3 deploy to work).

---

### `api/app/shared/metrics.py`

```python
"""
CloudWatch metrics via Embedded Metric Format (EMF).
EMF embeds metric data in structured log lines — no separate PutMetricData API call.
Zero additional AWS API cost.

Usage:
    from app.shared.metrics import counter, timer
    await counter("rithm.generation.jobs.submitted", dimensions={"kind": "generate"})
    async with timer("rithm.generation.job.duration", dimensions={"kind": "generate"}):
        ... do work ...
"""
import time
import json
import structlog
from contextlib import asynccontextmanager
from typing import AsyncGenerator

logger = structlog.get_logger()

_EMF_NAMESPACE = "RITHM"


def _emit_emf(metric_name: str, value: float, unit: str, dimensions: dict[str, str]) -> None:
    """
    Emit a CloudWatch metric using the EMF log format.
    CloudWatch Logs Agent picks this up and converts to metric data.
    """
    emf_doc = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": _EMF_NAMESPACE,
                    "Dimensions": [list(dimensions.keys())],
                    "Metrics": [{"Name": metric_name, "Unit": unit}],
                }
            ],
        },
        **dimensions,
        metric_name: value,
    }
    # Emit as a raw JSON line — structlog will not process this further
    print(json.dumps(emf_doc), flush=True)


async def counter(metric_name: str, value: float = 1, dimensions: dict[str, str] | None = None) -> None:
    _emit_emf(metric_name, value, "Count", dimensions or {})


async def gauge(metric_name: str, value: float, dimensions: dict[str, str] | None = None) -> None:
    _emit_emf(metric_name, value, "None", dimensions or {})


@asynccontextmanager
async def timer(metric_name: str, dimensions: dict[str, str] | None = None) -> AsyncGenerator[None, None]:
    t_start = time.monotonic()
    try:
        yield
    finally:
        duration = time.monotonic() - t_start
        _emit_emf(metric_name, duration, "Seconds", dimensions or {})
```

---

### `ops/cloudwatch/alarms.json`

Defines all P1 and P2 alarms from §8.3. Structure:

```json
[
  {
    "AlarmName": "rithm-api-5xx-rate",
    "AlarmDescription": "P1: API 5xx rate > 5% over 5 minutes",
    "Namespace": "AWS/ApplicationELB",
    "MetricName": "HTTPCode_Target_5XX_Count",
    "Dimensions": [
      {"Name": "LoadBalancer", "Value": "app/rithm-alb/PLACEHOLDER"}
    ],
    "Period": 300,
    "EvaluationPeriods": 1,
    "Threshold": 5.0,
    "ComparisonOperator": "GreaterThanThreshold",
    "TreatMissingData": "notBreaching",
    "AlarmActions": ["arn:aws:sns:us-east-1:ACCOUNT:rithm-ops-alerts"],
    "OKActions": ["arn:aws:sns:us-east-1:ACCOUNT:rithm-ops-alerts"]
  },
  {
    "AlarmName": "rithm-generation-dlq-depth",
    "AlarmDescription": "P1: Jobs DLQ has messages — generation failures exceeding retry limit",
    "Namespace": "AWS/SQS",
    "MetricName": "ApproximateNumberOfMessagesVisible",
    "Dimensions": [
      {"Name": "QueueName", "Value": "rithm-generation-jobs-dlq"}
    ],
    "Period": 60,
    "EvaluationPeriods": 1,
    "Threshold": 0,
    "ComparisonOperator": "GreaterThanThreshold",
    "TreatMissingData": "notBreaching",
    "AlarmActions": ["arn:aws:sns:us-east-1:ACCOUNT:rithm-ops-alerts"]
  },
  {
    "AlarmName": "rithm-sns-completions-dlq-depth",
    "AlarmDescription": "P1: SNS completions DLQ has messages — worker→API callback path broken",
    "Namespace": "AWS/SQS",
    "MetricName": "ApproximateNumberOfMessagesVisible",
    "Dimensions": [
      {"Name": "QueueName", "Value": "rithm-sns-completions-dlq"}
    ],
    "Period": 60,
    "EvaluationPeriods": 1,
    "Threshold": 0,
    "ComparisonOperator": "GreaterThanThreshold",
    "TreatMissingData": "notBreaching",
    "AlarmActions": ["arn:aws:sns:us-east-1:ACCOUNT:rithm-ops-alerts"]
  },
  {
    "AlarmName": "rithm-worker-desired-stuck-at-max",
    "AlarmDescription": "P1: Worker scaling stuck at max — queue draining slower than arrival",
    "Namespace": "AWS/ECS",
    "MetricName": "DesiredTaskCount",
    "Dimensions": [
      {"Name": "ClusterName", "Value": "rithm-prod"},
      {"Name": "ServiceName", "Value": "rithm-worker"}
    ],
    "Period": 300,
    "EvaluationPeriods": 6,
    "Threshold": 1.5,
    "ComparisonOperator": "GreaterThanThreshold",
    "TreatMissingData": "notBreaching",
    "AlarmActions": ["arn:aws:sns:us-east-1:ACCOUNT:rithm-ops-alerts"]
  },
  {
    "AlarmName": "rithm-rds-connections-high",
    "AlarmDescription": "P1: RDS connection count approaching limit",
    "Namespace": "AWS/RDS",
    "MetricName": "DatabaseConnections",
    "Dimensions": [
      {"Name": "DBInstanceIdentifier", "Value": "rithm-prod-db"}
    ],
    "Period": 300,
    "EvaluationPeriods": 1,
    "Threshold": 70,
    "ComparisonOperator": "GreaterThanThreshold",
    "TreatMissingData": "notBreaching",
    "AlarmActions": ["arn:aws:sns:us-east-1:ACCOUNT:rithm-ops-alerts"]
  }
]
```

> **Note**: Replace `ACCOUNT`, ALB ARN suffix, and resource names with real values
> after AWS setup runbook is complete. A shell script in `ops/scripts/put-alarms.sh`
> should iterate this JSON array and call `aws cloudwatch put-metric-alarm` for each.

---

### Runbook structure — `ops/runbooks/dlq-drain.md` (representative)

All 9 runbooks follow this template:

```markdown
# DLQ Drain Runbook

## Trigger Condition
CloudWatch alarm `rithm-generation-dlq-depth` fires (DLQ depth ≥ 1).

## Diagnostic Steps
1. Check DLQ message count: `aws sqs get-queue-attributes --queue-url <DLQ_URL> --attribute-names All`
2. Inspect message body: `aws sqs receive-message --queue-url <DLQ_URL> --max-number-of-messages 1`
3. Extract `job_id` from message body. Look up in DB: `SELECT * FROM generation.jobs WHERE id = '<job_id>';`
4. Check CloudWatch Logs for the worker task that processed this job: filter by `job_id`.
5. Determine failure class: OOM? Inference timeout? Network failure? S3 error?

## Remediation Steps
1. **If OOM**: Switch worker instance type to g5.xlarge (§9.3 trigger #1). Clear DLQ.
2. **If inference timeout (> 180s)**: Job had `length_seconds` > 120. Check if rate limit config needs tightening.
3. **If network/S3 error**: Transient failure — replay DLQ messages back to the main queue.
4. **If permanent failure**: Mark job FAILED via admin endpoint: `POST /api/v1/admin/jobs/{id}/force-fail`
5. To replay DLQ → main queue:
   ```bash
   aws sqs change-message-visibility \
     --queue-url <DLQ_URL> \
     --receipt-handle <HANDLE> \
     --visibility-timeout 0
   # Then redrive from DLQ back to source queue via AWS console or CLI
   ```

## Escalation
If DLQ depth > 10 or pattern repeats over 24h: escalate to engineering lead with DLQ message samples.

## What Should Have Prevented This
- A CloudWatch alarm on worker task restart count would catch crash loops before jobs accumulate in DLQ.
- Per-`error_class` metric breakdown helps identify the failure class without log diving.
```

---

## Day 4 Exit Gate

```bash
# Gate 1: Every API request has JSON log output with request_id
curl -s http://localhost:8080/health
# Docker log should show structured JSON: {"request_id": "...", "status": "ok", ...}

# Gate 2: Unknown route returns Problem+JSON (not HTML)
curl -s http://localhost:8080/nonexistent | jq .type
# expects: "https://rithm.dev/errors/404"

# Gate 3: All 9 runbooks exist with content
ls ops/runbooks/ | wc -l   # expects: 9
head -5 ops/runbooks/dlq-drain.md

# Gate 4: Alarms JSON is valid
python -m json.tool ops/cloudwatch/alarms.json > /dev/null && echo "valid JSON"
```

---

---

## DAY 5 — Music Worker: PoC Implementation

**Goal**: Production-quality worker code deployed to g4dn.xlarge spot.
PoC gate: 30s / 90s / 180s generations without OOM on T4 16 GB VRAM.
Audio-reference path produces coherent output. Loudnorm hits -14 LUFS ± 1.

> **Architect note**: Day 5 code is not a prototype. The worker is the hardest service
> to hot-patch (12 GB image rebuild, spot scheduling delay). Write it right now.

---

### `worker/worker/config.py`

```python
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        case_sensitive=False,
    )

    # AWS
    aws_region: str = "us-east-1"
    aws_endpoint_url: str | None = None   # LocalStack in local dev

    # Queue / messaging
    sqs_queue_url: str
    assets_bucket: str
    sns_completions_topic_arn: str

    # Database (generation schema only — sync psycopg2)
    db_generation_dsn: SecretStr   # use rithm_generation user

    # Worker behavior
    sqs_visibility_timeout: int = 300      # 5 min covers worst-case 180s track
    sqs_wait_seconds: int = 20             # long-poll
    idle_shutdown_seconds: int = 600       # 10 min idle → exit (triggers scale-to-zero)
    spot_interruption_poll_seconds: int = 5

    # Model
    model_weights_path: str = "/opt/acestep/weights"

    # Post-processing
    target_lufs: float = -14.0
    mp3_bitrate: str = "192k"

    # Operational
    log_level: str = "INFO"


@lru_cache
def get_settings() -> WorkerSettings:
    return WorkerSettings()
```

---

### `worker/worker/model.py`

The `MusicModel` Protocol is the contract. `ACEStepModel` is the Phase 1 implementation.
Future models (MusicGen, Riffusion) plug in without changing any other code.

```python
"""
MusicModel protocol + ACE-Step v1.5 implementation.

IMPORTANT FOR DAY 5 IMPLEMENTER:
The ACEStepModel._load_model(), generate(), and refine_from_audio() method bodies
must be filled in from the ACE-Step v1.5 Python API docs / source.
The scaffolding here provides the correct interface and error boundaries.
"""
from typing import Protocol, runtime_checkable
from pathlib import Path
import structlog
import tempfile

logger = structlog.get_logger()


@runtime_checkable
class MusicModel(Protocol):
    """
    Contract for all music generation models.
    Implementations must be side-effect-free in the constructor
    (no network calls; weights must already be on disk).
    """

    def generate(
        self,
        prompt: str,
        genre: str | None,
        mood: str | None,
        bpm: int | None,
        instruments: list[str],
        vocal: bool,
        length_s: float,
        seed: int | None,
    ) -> Path:
        """
        Generate a new track from a text description.
        Returns: path to a temporary WAV file.
        Caller is responsible for cleanup.
        """
        ...

    def refine_from_audio(
        self,
        audio_path: Path,
        delta_command: str,
        length_s: float,
        seed: int | None,
    ) -> Path:
        """
        Generate a new track conditioned on an existing audio reference.
        Returns: path to a temporary WAV file.
        Caller is responsible for cleanup.
        """
        ...


class ACEStepModel:
    """
    ACE-Step v1.5 implementation of MusicModel.

    PoC gate checklist (Day 5):
    ✓ Loads in fp16 without OOM on T4 16 GB (target: < 12 GB VRAM for 3-min output)
    ✓ generate() produces coherent audio for 30s / 90s / 180s lengths
    ✓ refine_from_audio() produces coherent output from a reference WAV
    ✓ No GPU memory leak after repeated calls (run 5 consecutive generations)
    """

    def __init__(self, weights_path: str) -> None:
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError(
                "CUDA not available. The worker requires a GPU. "
                "If running locally for testing, set CUDA_VISIBLE_DEVICES and ensure "
                "NVIDIA drivers are installed."
            )

        self._device = torch.device("cuda")
        logger.info("model_loading", weights_path=weights_path, device=str(self._device))

        self._model = self._load_model(weights_path)

        vram_allocated = torch.cuda.memory_allocated(self._device) / 1e9
        vram_reserved = torch.cuda.memory_reserved(self._device) / 1e9
        logger.info(
            "model_loaded",
            vram_allocated_gb=round(vram_allocated, 2),
            vram_reserved_gb=round(vram_reserved, 2),
        )

    def _load_model(self, weights_path: str):
        """
        ⚠️  IMPLEMENT FROM ACE-STEP V1.5 DOCS ⚠️
        Load ACE-Step v1.5 in fp16 to minimize VRAM usage.

        Example pattern (adapt to actual ACE-Step API):
            import torch
            from acestep import ACEStep  # or whatever the import is

            model = ACEStep.from_pretrained(weights_path)
            model = model.half()          # fp16
            model = model.to(self._device)
            model.eval()
            return model
        """
        raise NotImplementedError(
            "ACE-Step model loading not yet implemented. "
            "Review ACE-Step v1.5 repo at github.com/ACE-Step/ACE-Step "
            "for the correct loading API."
        )

    def _build_structured_prompt(
        self,
        prompt: str,
        genre: str | None,
        mood: str | None,
        bpm: int | None,
        instruments: list[str],
        vocal: bool,
    ) -> str:
        """
        Combine free-form prompt with structured parameters into a single
        prompt string for ACE-Step. Adapt format to what ACE-Step v1.5 expects.
        """
        parts = [prompt]
        if genre:
            parts.append(f"Genre: {genre}")
        if mood:
            parts.append(f"Mood: {mood}")
        if bpm:
            parts.append(f"BPM: {bpm}")
        if instruments:
            parts.append(f"Instruments: {', '.join(instruments)}")
        if not vocal:
            parts.append("Instrumental, no vocals")
        return ". ".join(parts)

    def generate(
        self,
        prompt: str,
        genre: str | None,
        mood: str | None,
        bpm: int | None,
        instruments: list[str],
        vocal: bool,
        length_s: float,
        seed: int | None,
    ) -> Path:
        import torch
        import torchaudio

        structured_prompt = self._build_structured_prompt(
            prompt, genre, mood, bpm, instruments, vocal
        )
        logger.info(
            "inference_start",
            kind="generate",
            length_s=length_s,
            prompt_preview=structured_prompt[:80],
        )

        # Set seed for reproducibility / variation control
        if seed is not None:
            torch.manual_seed(seed)
            torch.cuda.manual_seed(seed)

        with torch.inference_mode():
            # ⚠️  IMPLEMENT FROM ACE-STEP V1.5 DOCS ⚠️
            # audio_tensor = self._model.generate(
            #     prompt=structured_prompt,
            #     duration=length_s,
            #     ...
            # )
            raise NotImplementedError("ACE-Step generate() not implemented")

        output_path = Path(tempfile.mktemp(suffix=".wav", dir="/tmp"))
        torchaudio.save(str(output_path), audio_tensor.cpu(), 44100)
        logger.info("inference_complete", output_path=str(output_path))
        return output_path

    def refine_from_audio(
        self,
        audio_path: Path,
        delta_command: str,
        length_s: float,
        seed: int | None,
    ) -> Path:
        import torch
        import torchaudio

        logger.info(
            "inference_start",
            kind="refine_audio",
            length_s=length_s,
            delta=delta_command[:60],
        )

        if seed is not None:
            torch.manual_seed(seed)
            torch.cuda.manual_seed(seed)

        with torch.inference_mode():
            # ⚠️  IMPLEMENT FROM ACE-STEP V1.5 DOCS ⚠️
            # audio_tensor = self._model.refine(
            #     audio_path=str(audio_path),
            #     command=delta_command,
            #     duration=length_s,
            #     ...
            # )
            raise NotImplementedError("ACE-Step refine_from_audio() not implemented")

        output_path = Path(tempfile.mktemp(suffix=".wav", dir="/tmp"))
        torchaudio.save(str(output_path), audio_tensor.cpu(), 44100)
        return output_path
```

> **Day 5 PoC task**: Fill in `_load_model`, `generate`, and `refine_from_audio` from the
> ACE-Step v1.5 repository README / examples. The scaffolding, error handling, logging,
> and Protocol contract are final — only the model invocation lines change.

---

### `worker/worker/processor.py`

```python
"""
Audio post-processing: loudness normalization + MP3 encoding.
All operations use subprocess + ffmpeg — no Python audio libraries for post-processing.
This keeps the dependency surface minimal and uses battle-tested ffmpeg codecs.
"""
import hashlib
import json
import re
import subprocess
import tempfile
import wave
from pathlib import Path
import structlog

logger = structlog.get_logger()


def loudnorm(input_wav: Path, target_lufs: float = -14.0) -> Path:
    """
    Two-pass ffmpeg loudness normalization.
    Pass 1: measure loudness of source.
    Pass 2: apply normalization with exact measured values (linear mode).
    Target: I=-14 LRA=11 TP=-1.0 — Spotify / Apple Music / YouTube standard.
    """
    output_wav = Path(tempfile.mktemp(suffix="_norm.wav", dir="/tmp"))

    # Pass 1: measure
    result = subprocess.run(
        [
            "ffmpeg", "-i", str(input_wav),
            "-af", f"loudnorm=I={target_lufs}:LRA=11:TP=-1.0:print_format=json",
            "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg loudnorm pass 1 failed:\n{result.stderr[-500:]}")

    # Parse measured values from stderr
    json_match = re.search(r'\{[^{}]+\}', result.stderr, re.DOTALL)
    if not json_match:
        raise RuntimeError("Could not parse loudnorm stats from ffmpeg stderr")
    stats = json.loads(json_match.group())

    # Pass 2: normalize with measured values (linear=true → no distortion)
    result2 = subprocess.run(
        [
            "ffmpeg", "-i", str(input_wav),
            "-af", (
                f"loudnorm=I={target_lufs}:LRA=11:TP=-1.0"
                f":measured_I={stats['input_i']}"
                f":measured_LRA={stats['input_lra']}"
                f":measured_TP={stats['input_tp']}"
                f":measured_thresh={stats['input_thresh']}"
                f":offset={stats['target_offset']}"
                f":linear=true:print_format=summary"
            ),
            "-ar", "44100",
            "-y", str(output_wav),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result2.returncode != 0:
        raise RuntimeError(f"ffmpeg loudnorm pass 2 failed:\n{result2.stderr[-500:]}")

    logger.info("loudnorm_complete", output_size_mb=round(output_wav.stat().st_size / 1e6, 1))
    return output_wav


def encode_mp3(input_wav: Path, bitrate: str = "192k") -> Path:
    """Encode WAV → MP3 at 192kbps CBR, 44.1kHz sample rate."""
    output_mp3 = Path(tempfile.mktemp(suffix=".mp3", dir="/tmp"))
    result = subprocess.run(
        [
            "ffmpeg", "-i", str(input_wav),
            "-codec:a", "libmp3lame",
            "-b:a", bitrate,
            "-ar", "44100",
            "-y", str(output_mp3),
        ],
        capture_output=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg MP3 encode failed:\n{result.stderr[-300:]}")

    logger.info("mp3_encode_complete", size_mb=round(output_mp3.stat().st_size / 1e6, 2))
    return output_mp3


def probe_duration(audio_path: Path) -> float:
    """Get audio duration in seconds via ffprobe."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            str(audio_path),
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if result.returncode != 0:
        raise RuntimeError("ffprobe failed")
    info = json.loads(result.stdout)
    return float(info["format"]["duration"])


def sha256_audio_samples(wav_path: Path) -> str:
    """
    SHA-256 hash over raw PCM sample bytes.
    Used to verify TTM-04 (variation produces different waveform hash)
    and detect accidental duplicates.
    """
    h = hashlib.sha256()
    with wave.open(str(wav_path), "rb") as wf:
        while chunk := wf.readframes(8192):
            h.update(chunk)
    return h.hexdigest()
```

---

### `worker/worker/db.py`

```python
"""
DB operations for the worker — sync only (psycopg2).
The worker only touches generation.jobs for:
  1. Idempotency claim (QUEUED → RUNNING)
  2. Mark FAILED on permanent errors
"""
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from functools import lru_cache
import structlog

logger = structlog.get_logger()


@lru_cache
def _get_engine() -> Engine:
    from worker.config import get_settings
    settings = get_settings()
    dsn = settings.db_generation_dsn.get_secret_value()
    # Convert asyncpg DSN format to sync psycopg2 if needed
    sync_dsn = dsn.replace("postgresql+asyncpg://", "postgresql://")
    return create_engine(
        sync_dsn,
        pool_size=2,
        max_overflow=0,
        pool_pre_ping=True,
        connect_args={"connect_timeout": 10},
    )


def claim_job(job_id: str, worker_id: str) -> bool:
    """
    Atomically transition a job from QUEUED → RUNNING.

    Returns True if this worker successfully claimed the job.
    Returns False if the job was already claimed by another worker
    (SQS at-least-once delivery / spot interruption retry scenario).

    Uses a single UPDATE ... WHERE status='QUEUED' RETURNING id — no
    separate SELECT needed. Safe under concurrent workers.
    """
    with _get_engine().begin() as conn:
        result = conn.execute(
            text("""
                UPDATE generation.jobs
                   SET status     = 'RUNNING',
                       started_at = now(),
                       worker_id  = :worker_id,
                       attempt    = attempt + 1
                 WHERE id     = :job_id
                   AND status = 'QUEUED'
                RETURNING id
            """),
            {"job_id": job_id, "worker_id": worker_id},
        )
        claimed = result.fetchone() is not None

    if not claimed:
        logger.info("job_already_claimed", job_id=job_id, worker_id=worker_id)
    return claimed


def fail_job(job_id: str, error: str) -> None:
    """Mark a job FAILED in the DB. Called before publishing FAILED SNS event."""
    with _get_engine().begin() as conn:
        conn.execute(
            text("""
                UPDATE generation.jobs
                   SET status       = 'FAILED',
                       completed_at = now(),
                       error        = :error
                 WHERE id = :job_id
            """),
            {"job_id": job_id, "error": error[:2000]},
        )
```

---

### `worker/worker/messaging.py`

```python
"""
SQS consumer + SNS publisher for the music worker.
Uses sync boto3 — the worker is not an async process.
"""
import boto3
import json
import datetime
from functools import lru_cache
import structlog

logger = structlog.get_logger()


def _make_client(service: str):
    from worker.config import get_settings
    settings = get_settings()
    kwargs: dict = {"region_name": settings.aws_region}
    if settings.aws_endpoint_url:
        kwargs["endpoint_url"] = settings.aws_endpoint_url
    return boto3.client(service, **kwargs)


# Clients are module-level singletons (not lru_cache — boto3 clients are not picklable)
_sqs_client = None
_sns_client = None


def _sqs():
    global _sqs_client
    if _sqs_client is None:
        _sqs_client = _make_client("sqs")
    return _sqs_client


def _sns():
    global _sns_client
    if _sns_client is None:
        _sns_client = _make_client("sns")
    return _sns_client


def receive_message() -> dict | None:
    """
    Long-poll SQS for exactly one message.
    Returns the raw SQS message dict, or None if the poll timed out with no message.
    """
    from worker.config import get_settings
    settings = get_settings()
    response = _sqs().receive_message(
        QueueUrl=settings.sqs_queue_url,
        MaxNumberOfMessages=1,
        WaitTimeSeconds=settings.sqs_wait_seconds,
        VisibilityTimeout=settings.sqs_visibility_timeout,
    )
    messages = response.get("Messages", [])
    return messages[0] if messages else None


def delete_message(receipt_handle: str) -> None:
    """Ack a successfully processed message."""
    from worker.config import get_settings
    settings = get_settings()
    _sqs().delete_message(
        QueueUrl=settings.sqs_queue_url,
        ReceiptHandle=receipt_handle,
    )


def return_message_to_queue(receipt_handle: str) -> None:
    """
    Return an in-flight message back to the queue immediately.
    Used on spot interruption: message becomes visible to other workers immediately.
    """
    from worker.config import get_settings
    settings = get_settings()
    _sqs().change_message_visibility(
        QueueUrl=settings.sqs_queue_url,
        ReceiptHandle=receipt_handle,
        VisibilityTimeout=0,
    )
    logger.info("message_returned_to_queue", reason="spot_interruption")


def publish_completion(
    topic_arn: str,
    job_id: str,
    status: str,
    s3_wav_key: str | None = None,
    s3_mp3_key: str | None = None,
    duration_seconds: float | None = None,
    waveform_hash: str | None = None,
    worker_id: str | None = None,
    error: str | None = None,
    error_class: str | None = None,
) -> None:
    """Publish job completion (success or failure) to SNS."""
    now = datetime.datetime.utcnow().isoformat() + "Z"
    payload: dict = {
        "schema_version": 1,
        "job_id": job_id,
        "status": status,
        "worker_id": worker_id,
    }
    if status == "COMPLETED":
        payload.update({
            "s3_wav_key": s3_wav_key,
            "s3_mp3_key": s3_mp3_key,
            "duration_seconds": duration_seconds,
            "waveform_hash": waveform_hash,
            "completed_at": now,
        })
    elif status == "FAILED":
        payload.update({
            "error": error,
            "error_class": error_class,
            "failed_at": now,
        })

    _sns().publish(TopicArn=topic_arn, Message=json.dumps(payload))
    logger.info("sns_published", status=status, job_id=job_id)
```

---

### `worker/worker/storage.py`

```python
"""S3 operations: upload processed audio, download reference WAVs."""
import boto3
import tempfile
from pathlib import Path
import structlog

logger = structlog.get_logger()

_s3_client = None


def _s3():
    global _s3_client
    if _s3_client is None:
        from worker.config import get_settings
        settings = get_settings()
        kwargs: dict = {"region_name": settings.aws_region}
        if settings.aws_endpoint_url:
            kwargs["endpoint_url"] = settings.aws_endpoint_url
        _s3_client = boto3.client("s3", **kwargs)
    return _s3_client


def upload_file(local_path: Path, s3_key: str) -> None:
    from worker.config import get_settings
    settings = get_settings()
    size_mb = round(local_path.stat().st_size / 1e6, 1)
    logger.info("s3_upload_start", key=s3_key, size_mb=size_mb)
    _s3().upload_file(str(local_path), settings.assets_bucket, s3_key)
    logger.info("s3_upload_complete", key=s3_key)


def download_to_temp(s3_key: str) -> Path:
    """Download an S3 object to a temporary file. Returns the local path."""
    from worker.config import get_settings
    settings = get_settings()
    suffix = Path(s3_key).suffix or ".wav"
    local_path = Path(tempfile.mktemp(suffix=suffix, dir="/tmp"))
    logger.info("s3_download_start", key=s3_key)
    _s3().download_file(settings.assets_bucket, s3_key, str(local_path))
    logger.info("s3_download_complete", key=s3_key, size_mb=round(local_path.stat().st_size / 1e6, 1))
    return local_path
```

---

### `worker/worker/main.py`

The main loop. This is the most important file in the worker.

```python
"""
RITHM Music Worker — Main Loop

Architecture:
- Single-threaded main loop (one job at a time per worker task)
- Spot interruption watcher in a daemon thread
- Graceful shutdown on SIGTERM: finish current job if < 90s remaining, else requeue
- Scale-to-zero: exit after 10 min idle (ECS desired count driven by SQS alarm)
"""
import json
import os
import signal
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional
import structlog

logger = structlog.get_logger()

# Global shutdown flag — set by SIGTERM handler or spot interruption watcher
_shutdown_requested = threading.Event()

# Receipt handle of currently-in-flight SQS message (for spot interruption requeue)
_current_receipt_handle: Optional[str] = None
_current_job_start: Optional[float] = None


def _handle_signal(signum: int, _frame) -> None:
    logger.info("signal_received", signum=signum)
    _shutdown_requested.set()


def _get_worker_id() -> str:
    """Return ECS Task ARN (most precise worker identity), or hostname fallback."""
    metadata_uri = os.environ.get("ECS_CONTAINER_METADATA_URI_V4", "")
    if metadata_uri:
        try:
            with urllib.request.urlopen(f"{metadata_uri}/task", timeout=2) as r:
                data = json.loads(r.read())
                return data.get("TaskARN", os.uname().nodename)
        except Exception:
            pass
    return os.uname().nodename


def _spot_interruption_watcher(poll_interval: int) -> None:
    """
    Poll IMDS v2 for spot termination notice every `poll_interval` seconds.
    On 2-minute warning:
      - If currently processing a job that started > 90s ago: requeue it
      - Set _shutdown_requested so main loop exits cleanly
    Runs in a daemon thread — dies when main thread exits.
    """
    token_url = "http://169.254.169.254/latest/api/token"
    notice_url = "http://169.254.169.254/latest/meta-data/spot/termination-time"

    while not _shutdown_requested.is_set():
        try:
            token_req = urllib.request.Request(
                token_url,
                headers={"X-aws-ec2-metadata-token-ttl-seconds": "30"},
                method="PUT",
            )
            with urllib.request.urlopen(token_req, timeout=1) as r:
                token = r.read().decode()

            notice_req = urllib.request.Request(
                notice_url,
                headers={"X-aws-ec2-metadata-token": token},
            )
            with urllib.request.urlopen(notice_req, timeout=1) as r:
                termination_time = r.read().decode()
                logger.warning(
                    "spot_interruption_notice",
                    termination_time=termination_time,
                    event_type="spot.interruption",
                )
                # If job has been running > 90s, it won't finish in the 2-min window.
                # Requeue it so another worker picks it up.
                if (
                    _current_receipt_handle is not None
                    and _current_job_start is not None
                    and time.monotonic() - _current_job_start > 90
                ):
                    logger.info("spot_requeue_long_running_job")
                    from worker.messaging import return_message_to_queue
                    return_message_to_queue(_current_receipt_handle)

                _shutdown_requested.set()

        except urllib.error.HTTPError as e:
            if e.code == 404:
                pass  # Normal — no interruption notice
        except Exception:
            pass  # IMDS not reachable (non-EC2 env) — silently ignore

        time.sleep(poll_interval)


def _run_inference(model, job: dict) -> Path:
    """Route job to the correct model method based on kind."""
    kind = job["kind"]
    params = job["params"]

    if kind in ("generate", "refine_fresh"):
        return model.generate(
            prompt=params["prompt"],
            genre=params.get("genre"),
            mood=params.get("mood"),
            bpm=params.get("bpm"),
            instruments=params.get("instruments", []),
            vocal=params.get("vocal", True),
            length_s=float(params["length_seconds"]),
            seed=params.get("seed"),
        )

    if kind == "variation":
        import random
        orig = params.get("original_params", params)
        return model.generate(
            prompt=orig["prompt"],
            genre=orig.get("genre"),
            mood=orig.get("mood"),
            bpm=orig.get("bpm"),
            instruments=orig.get("instruments", []),
            vocal=orig.get("vocal", True),
            length_s=float(orig.get("length_seconds", 90)),
            seed=random.randint(0, 2**31 - 1),  # different seed = different track
        )

    if kind == "refine_audio":
        from worker.storage import download_to_temp
        ref_key = params["audio_reference_url"]  # S3 key in same-account scenario
        ref_local = download_to_temp(ref_key)
        try:
            return model.refine_from_audio(
                audio_path=ref_local,
                delta_command=params["delta_command"],
                length_s=float(params["length_seconds"]),
                seed=params.get("seed"),
            )
        finally:
            ref_local.unlink(missing_ok=True)

    raise ValueError(f"Unknown job kind: {kind!r}")


def _process_job(msg: dict, model, worker_id: str) -> None:
    """
    Process one SQS message end-to-end.
    All exceptions are caught and translated into FAILED status — no exception escapes
    to the main loop.
    """
    global _current_receipt_handle, _current_job_start

    raw_body = msg["Body"]
    receipt_handle = msg["ReceiptHandle"]
    job = json.loads(raw_body)

    # Validate schema version
    if job.get("schema_version", 0) != 1:
        logger.error("unsupported_schema_version", schema_version=job.get("schema_version"))
        # Delete the message — it will never succeed with an unknown schema
        from worker.messaging import delete_message
        delete_message(receipt_handle)
        return

    job_id = job["job_id"]
    user_id = job["user_id"]
    callback_topic = job["callback_topic_arn"]

    log = logger.bind(job_id=job_id, user_id=user_id, kind=job["kind"])
    log.info("job_received")

    # Idempotency: atomically claim the job (QUEUED → RUNNING)
    from worker.db import claim_job, fail_job
    if not claim_job(job_id, worker_id):
        # Another worker already claimed this job (SQS at-least-once / spot retry).
        # Silently drop the duplicate message.
        from worker.messaging import delete_message
        delete_message(receipt_handle)
        return

    _current_receipt_handle = receipt_handle
    _current_job_start = time.monotonic()

    from worker.config import get_settings
    from worker.messaging import delete_message, publish_completion
    from worker.processor import loudnorm, encode_mp3, probe_duration, sha256_audio_samples
    from worker.storage import upload_file

    settings = get_settings()
    tmp_wav: Optional[Path] = None
    tmp_normalized: Optional[Path] = None
    tmp_mp3: Optional[Path] = None

    try:
        t0 = time.monotonic()

        # 1. Inference
        tmp_wav = _run_inference(model, job)
        log.info("inference_complete", inference_s=round(time.monotonic() - t0, 1))

        # 2. Loudness normalization (two-pass)
        tmp_normalized = loudnorm(tmp_wav, settings.target_lufs)

        # 3. MP3 encode
        tmp_mp3 = encode_mp3(tmp_normalized, settings.mp3_bitrate)

        # 4. Collect audio metadata
        duration = probe_duration(tmp_mp3)
        waveform_hash = sha256_audio_samples(tmp_normalized)

        # 5. Upload both assets to S3
        wav_key = f"tracks/{user_id}/{job_id}/master.wav"
        mp3_key = f"tracks/{user_id}/{job_id}/audio.mp3"
        upload_file(tmp_normalized, wav_key)
        upload_file(tmp_mp3, mp3_key)

        # 6. Publish COMPLETED to SNS
        publish_completion(
            topic_arn=callback_topic,
            job_id=job_id,
            status="COMPLETED",
            s3_wav_key=wav_key,
            s3_mp3_key=mp3_key,
            duration_seconds=duration,
            waveform_hash=waveform_hash,
            worker_id=worker_id,
        )

        # 7. Ack the SQS message (only after everything else succeeded)
        delete_message(receipt_handle)

        total_s = round(time.monotonic() - t0, 1)
        log.info("job_completed", total_s=total_s, duration_s=round(duration, 1))

    except Exception as exc:
        error_class = type(exc).__name__
        error_msg = str(exc)[:2000]
        log.exception("job_failed", error_class=error_class, error=error_msg)

        try:
            fail_job(job_id, error_msg)
            publish_completion(
                topic_arn=callback_topic,
                job_id=job_id,
                status="FAILED",
                worker_id=worker_id,
                error=error_msg,
                error_class=error_class,
            )
            delete_message(receipt_handle)
        except Exception as inner:
            # Cleanup itself failed — log and let SQS retry (don't delete message)
            log.exception("cleanup_failed", inner=str(inner))

    finally:
        _current_receipt_handle = None
        _current_job_start = None
        # Cleanup temp files
        for tmp in [tmp_wav, tmp_normalized, tmp_mp3]:
            if tmp is not None:
                tmp.unlink(missing_ok=True)


def main() -> None:
    from worker.logging_setup import configure_logging
    from worker.config import get_settings
    from worker.model import ACEStepModel
    from worker.messaging import receive_message

    settings = get_settings()
    configure_logging(settings.log_level)

    worker_id = _get_worker_id()
    logger.info("worker_starting", worker_id=worker_id)

    # Register signal handlers
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    # Start spot interruption watcher
    watcher = threading.Thread(
        target=_spot_interruption_watcher,
        args=(settings.spot_interruption_poll_seconds,),
        daemon=True,
        name="spot-watcher",
    )
    watcher.start()

    # Cold load the model (30-90s on first task start after scale-up)
    t_load = time.monotonic()
    logger.info("model_loading_start", weights_path=settings.model_weights_path)
    model = ACEStepModel(settings.model_weights_path)
    logger.info("model_loading_complete", duration_s=round(time.monotonic() - t_load, 1))

    idle_since = time.monotonic()

    # ── Main poll loop ──────────────────────────────────────────
    while not _shutdown_requested.is_set():
        msg = receive_message()

        if msg is None:
            idle_s = time.monotonic() - idle_since
            if idle_s > settings.idle_shutdown_seconds:
                logger.info(
                    "idle_shutdown",
                    idle_s=round(idle_s),
                    reason="no_messages_in_idle_window",
                )
                break
            continue

        idle_since = time.monotonic()
        _process_job(msg, model, worker_id)

    logger.info("worker_shutdown_complete", worker_id=worker_id)


if __name__ == "__main__":
    main()
```

---

### `worker/worker/logging_setup.py`

```python
import logging
import structlog


def configure_logging(log_level: str = "INFO") -> None:
    level = getattr(logging, log_level.upper(), logging.INFO)
    structlog.configure(
        processors=[
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
```

---

### Day 5 PoC Test Script — `ops/scripts/poc-test-worker.sh`

Run this on the g4dn.xlarge instance to verify the PoC gate.

```bash
#!/usr/bin/env bash
# PoC Gate Test — Day 5
# Run on the deployed worker EC2 instance after the worker container is live.
# Verifies: VRAM, latency, audio-reference path, loudnorm.
set -euo pipefail

QUEUE_URL="${SQS_JOBS_QUEUE_URL}"

send_job() {
  local job_id="$1"
  local length="$2"
  local kind="${3:-generate}"
  local extra="${4:-}"

  aws sqs send-message \
    --queue-url "$QUEUE_URL" \
    --message-body "{
      \"schema_version\": 1,
      \"job_id\": \"$job_id\",
      \"user_id\": \"00000000-0000-0000-0000-000000000001\",
      \"kind\": \"$kind\",
      \"params\": {
        \"prompt\": \"uplifting cinematic with strings\",
        \"genre\": \"Cinematic\",
        \"mood\": \"Inspirational\",
        \"bpm\": 110,
        \"instruments\": [\"strings\"],
        \"vocal\": false,
        \"length_seconds\": $length
        $extra
      },
      \"callback_topic_arn\": \"$SNS_COMPLETIONS_TOPIC_ARN\"
    }"
}

echo "=== PoC Gate Test ==="
echo "Test 1: 30s generation"
send_job "poc-test-30s" 30

echo "Test 2: 90s generation"
send_job "poc-test-90s" 90

echo "Test 3: 180s generation (worst-case VRAM test)"
send_job "poc-test-180s" 180

echo "Jobs submitted. Tail worker logs to observe VRAM usage and latency."
echo "Gate criteria:"
echo "  ✓ All 3 jobs complete (status=COMPLETED in generation.jobs)"
echo "  ✓ No CUDA OOM in worker logs"
echo "  ✓ VRAM allocated < 14 GB (T4 has 16 GB)"
echo "  ✓ 180s inference wall time < 90s"
echo "  ✓ MP3 files present in S3: tracks/000.../poc-test-*/audio.mp3"
echo "  ✓ Loudnorm target: ffmpeg -i audio.mp3 -af ebur128 should read ~-14 LUFS"
```

---

## Day 5 Exit Gate

```
✓ Worker Docker image builds successfully (nvidia/cuda base, PyTorch 2.3 + CUDA 12.1)
✓ Worker deploys to g4dn.xlarge spot via ECS
✓ ACEStepModel._load_model() succeeds — model in VRAM, no OOM
✓ generate() produces valid WAV for 30s / 90s / 180s
✓ refine_from_audio() produces coherent WAV from a 30s reference clip
✓ loudnorm() output measures -14 LUFS ±1 (verify with: ffmpeg loudnorm + ebur128)
✓ SHA-256 of two separate generate() calls with same prompt + different seeds differ
✓ Worker exits cleanly on SIGTERM mid-idle (no error, ECS tasks reach STOPPED)
✓ Worker exits after 10 min idle (scale-to-zero path confirmed)

If g4dn.xlarge T4 16GB OOMs on 180s:
→ Switch capacity provider to g5.xlarge (A10G 24GB) in ECS cluster console
→ Update worker task definition GPU instance type
→ Re-run test 3 only
→ Note in ops/runbooks/worker-stuck.md: "OOM on T4 at 180s — running on A10G"
→ No other code changes required
```

---

## Appendix A: Key Interface Contracts (Never Break These)

These contracts must be honored for all later phases to work without rework.

### 1. UUIDv7 — always app-generated, never DB-generated

```python
# In any module service that inserts a new row:
from uuid_utils import uuid7
new_id = uuid7()   # NOT uuid.uuid4(), NOT gen_random_uuid()
```

### 2. Async DB session pattern

```python
# Every service function that touches the DB:
async def create_something(self, ...) -> Something:
    async with get_session("module_name") as session:
        obj = SomeModel(id=uuid7(), ...)
        session.add(obj)
        # commit is automatic on context manager exit
    return obj
```

### 3. SQS message schema version check

```python
# Always validate schema_version on receipt (worker and API)
if job.get("schema_version", 0) != 1:
    logger.error("unsupported_schema_version")
    delete_message(receipt_handle)  # Don't retry — will never succeed
    return
```

### 4. Cross-schema FK pattern

```python
# These are LOGICAL references only — no DB-level FK enforcement
# Identity:
class Track(Base):
    user_id: Mapped[UUID]  # logical ref to identity.users.id
    # NO ForeignKey("identity.users.id") — would break per-module grants
```

### 5. Admin endpoint pattern

```python
# Every admin endpoint must:
# a) Use require_admin dependency
# b) Log an admin.action audit event
# c) Accept a `reason` body field (free-text ≤ 500 chars)
@router.post("/admin/jobs/{job_id}/force-fail")
async def admin_force_fail(
    job_id: UUID,
    body: AdminActionRequest,
    admin_user_id: UUID = Depends(require_admin),
):
    logger.info(
        "admin_action",
        event_type="admin.action",
        admin_user_id=str(admin_user_id),
        action="force_fail_job",
        target=str(job_id),
        reason=body.reason,
    )
```

### 6. SNS completion — always verify signature

```python
# In /internal/sns/job-completion:
payload = await request.json()
verify_sns_signature(payload)   # MUST be called before trusting anything
```

---

## Appendix B: Folder Ownership Matrix

| Directory | Owner | Notes |
|-----------|-------|-------|
| `api/app/modules/*/` | Backend dev | Never import across modules |
| `api/app/shared/` | Both devs | Shared by all modules — changes need cross-review |
| `worker/worker/` | Backend dev | GPU/infra heavy |
| `web/src/` | Full-stack dev | React + TypeScript |
| `ops/scripts/` | DevOps / both devs | SQL + bash — test before running in prod |
| `ops/runbooks/` | Both devs | Update on every new failure mode discovered |
| `.github/workflows/` | Both devs | Changes require both devs to review |
| `ops/task-definitions/` | Backend dev | Template JSON — ARNs filled in at deploy time |
