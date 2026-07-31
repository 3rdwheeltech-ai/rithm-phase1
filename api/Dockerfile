# ─── Stage 1: Python dependency resolver ──────────────────────
FROM python:3.12-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock* ./
# --no-install-project: only pyproject/uv.lock are in this stage's context, so
# hatchling cannot build the root project (it needs app/). Deps only.
RUN uv sync --frozen --no-dev --no-install-project

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
RUN uv sync --frozen --no-install-project

COPY app/ ./app/
COPY migrations/ ./migrations/

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--reload"]

# ─── Stage 3: Production ──────────────────────────────────────
FROM python:3.12-slim AS production

# curl only — the task-def healthcheck shells out to it.
# ffmpeg is deliberately NOT installed here: it drags in ~670MB of libav/x264
# and pushes the image to ~1GB, past the <500MB gate. The API never
# transcodes — loudnorm/mp3 lives in the worker image. (The development stage
# above keeps ffmpeg for local parity.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r rithm && useradd -r -g rithm rithm

WORKDIR /app
COPY --from=deps --chown=rithm:rithm /app/.venv ./.venv
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --chown=rithm:rithm app/ ./app/
COPY --chown=rithm:rithm migrations/ ./migrations/

USER rithm

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8080/health || exit 1

# SINGLE process — do NOT add --workers. The SSE hub is in-process pub/sub:
# a second worker process fragments it exactly the way a second ECS task does,
# so a completion delivered to process A never reaches a stream held on B.
# Horizontal scaling is an ECS desiredCount decision, and today that is 1.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
