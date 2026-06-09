# RITHM

AI music generation platform — Phase 0/1 monorepo.

## Repository layout

```
api/      FastAPI monolith (modular: identity, catalog, generation, conversation, personalization)
worker/   GPU generation worker (ACE-Step) — runs on EC2 spot, NOT in docker-compose
web/      React + Vite + Tailwind SPA
ops/      Runbooks, scripts, ECS task definitions, CloudWatch config
.github/  CI/CD workflows
docs/     Implementation specs
```

## Prerequisites

- Docker + docker-compose
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Node.js 20+

## Local development quickstart

```bash
# 1. Local env file (used by docker-compose api service)
cp .env.example .env.local

# 2. Start Postgres + LocalStack + API
docker-compose up -d --wait
docker-compose ps                       # all healthy

# 3. Verify
curl -s http://localhost:8080/health    # {"status":"ok","version":"0.1.0"}
```

To reset DB state (re-runs `ops/scripts/init-db-users.sql`): `docker-compose down -v`.

## Python packages

```bash
cd api && uv sync --frozen              # API (Python 3.12)
cd worker && uv sync --no-group gpu     # Worker without CUDA deps (Python 3.11)
```

> Note: the worker's `gpu` dependency group resolves against the PyTorch cu121 index
> (Linux-only wheels). `uv sync --no-group gpu` is the correct invocation on macOS/CI.

## Web

```bash
cd web && npm install && npm run dev    # http://localhost:5173
```

## Tests

```bash
cd api && uv run pytest -v
```

## Notes

- The GPU worker is intentionally absent from docker-compose — see the comment in
  `docker-compose.yml` and `docs/RITHM_Days1to5_CodeSpec.md`.
- CI/deploy workflows under `.github/workflows/` are Day 1 stubs; full pipelines land on Day 3.
