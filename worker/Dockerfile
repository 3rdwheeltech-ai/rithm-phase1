# One source tree, two runnable targets. Only run_inference /
# load_acestep_model differ between them — everything else is the same
# production code, which is what makes Gate C on the stub meaningful.
#
# Day 2 builds ONLY `--target stub`. The `weights` and `production` targets are
# written now so Day 3 fills in the model load and the weights fetch without
# reshaping the file; they are not expected to build today.

# ─── Stage: dependency resolver (shared by stub) ──────────────
FROM python:3.11-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /opt/rithm
COPY pyproject.toml uv.lock* ./
# --no-install-project: only pyproject/uv.lock are in this stage's context, so
# hatchling cannot build the root project (it needs worker/). Deps only.
# --no-group gpu: torch belongs to the production image, installed separately
# from the CUDA index. Pulling it here would put ~2.5GB into the stub.
RUN uv sync --frozen --no-dev --no-install-project --no-group gpu

# ─── Stage: stub — CPU-only, no torch, no weights ─────────────
FROM python:3.11-slim AS stub

# ffmpeg IS installed here, unlike the API image. The worker transcodes; the API
# never does. The stub skips inference, not post-processing — loudnorm, mp3
# encode, ffprobe and the PCM hash all run for real at Gate C.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r rithm && useradd -r -g rithm rithm

WORKDIR /opt/rithm
COPY --from=deps --chown=rithm:rithm /opt/rithm/.venv ./.venv
ENV PATH="/opt/rithm/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --chown=rithm:rithm worker/ ./worker/
COPY --chown=rithm:rithm fixtures/stub.wav /opt/rithm/fixtures/stub.wav

USER rithm

CMD ["python", "-m", "worker.main"]

# ─── Stage: weights — fetch ACE-Step v1.5 (Day 3) ─────────────
FROM python:3.11-slim AS weights
ARG HF_TOKEN
# Day 3 fills this in:
#   RUN pip install --no-cache-dir "huggingface_hub[cli]" \
#    && huggingface-cli download <repo> --local-dir /opt/acestep/weights
RUN mkdir -p /opt/acestep/weights

# ─── Stage: production — CUDA + torch + weights (Day 3) ───────
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 AS production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3.11 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /opt/rithm
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-dev --no-install-project --no-group gpu \
    && ./.venv/bin/pip install --no-cache-dir torch torchaudio \
       --index-url https://download.pytorch.org/whl/cu121

ENV PATH="/opt/rithm/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY worker/ ./worker/
COPY fixtures/stub.wav /opt/rithm/fixtures/stub.wav
# COPY --from=weights /opt/acestep/weights /opt/acestep/weights

CMD ["python", "-m", "worker.main"]
