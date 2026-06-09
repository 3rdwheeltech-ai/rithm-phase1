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
