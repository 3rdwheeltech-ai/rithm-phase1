# One source tree, two runnable targets — and since the PoC settled that
# ACE-Step v1.5 is an HTTP SERVER rather than a Python import, the two targets
# are now the same image. See the `production` stage for what that means.
#
# The `stub` target is a PROVEN ARTIFACT: Gate C ran on it and Gate D runs on it
# again. Do not touch it.
#
#   docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
#     --target production --cache-from $REGISTRY/rithm/worker:latest \
#     -t $REGISTRY/rithm/worker:$(git rev-parse --short HEAD) --push worker/
#
# No GPU, no CUDA base, no weights download, no HF_TOKEN. 914 MB on disk /
# 230 MB compressed — down from 22.7 GB / 8.19 GB before the PoC — and it
# builds anywhere in under a minute.

# ─── Stage: dependency resolver (shared by stub and production) ────
FROM python:3.11-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /opt/rithm
COPY pyproject.toml uv.lock* ./
# --no-install-project: only pyproject/uv.lock are in this stage's context, so
# hatchling cannot build the root project (it needs worker/). Deps only.
RUN uv sync --frozen --no-dev --no-install-project

# ─── Stage: stub — copies a canned WAV instead of generating ──────
FROM python:3.11-slim AS stub

# ffmpeg IS installed here, unlike the API image. The worker transcodes; the API
# never does. The stub skips inference, not post-processing — loudnorm, mp3
# encode, ffprobe and the PCM hash all run for real at Gate C.
#
# It is also NOT optional on the real path, and not available everywhere: the
# PoC found ffmpeg is absent from Amazon Linux 2023's base repositories, so any
# host running this pipeline outside a container needs it installed explicitly.
# Inside this image it is a package away, which is one more reason the worker
# stays containerised.
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

# ─── Stage: production — the same image, minus the stub flag ──────
#
# This is deliberately `FROM stub` and it is not laziness. Before the PoC, the
# real worker was expected to hold ACE-Step in-process: CUDA base image, torch
# from the cu121 index, ~12 GB of Hugging Face weights baked in, GPU=1 on the
# task. The PoC found ACE-Step v1.5 is a git checkout that serves HTTP, so the
# worker holds no model at all — it POSTs to /release_task and downloads the
# result. Nothing about the image needs to differ from the stub's.
#
# The only difference between a stub worker and a real one is now ENVIRONMENT:
#
#   stub:  RITHM_STUB_INFERENCE=1     (ACESTEP_API_BASE ignored)
#   real:  RITHM_STUB_INFERENCE unset, ACESTEP_API_BASE=http://<server>:8001
#
# Both targets are kept so existing runbooks and Gate D keep working, and so
# the intent of a build stays legible in the command that produced it.
#
# WHERE THE GPU WENT: to whatever runs the ACE-Step server — a sidecar container
# in the same task, or a standalone box. That image is built from ACE-Step's own
# repository (git clone + uv sync), not from this Dockerfile, because its
# dependency set is ACE-Step's business and not ours. Keeping the two apart is
# what lets the worker be redeployed in seconds without touching the model.
FROM stub AS production
