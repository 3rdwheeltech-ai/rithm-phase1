"""
The stubbed seam — and only this seam.

Everything else in the worker is production code that Gate C exercises for real.
That is the entire point of the stub build: by Day 3 the model call is the only
unproven line in the pipeline.

`import torch` appears ONLY inside the real branch of load_acestep_model. A
module-scope import would break `docker build --target stub`, because the stub
image has no CUDA and no torch wheel. tests/test_inference_stub.py asserts
"torch" not in sys.modules after a stub run, so a future refactor cannot quietly
hoist it.
"""
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

import structlog

from worker.config import get_settings

logger = structlog.get_logger()

# Baked into both images at this path (see Dockerfile). A real ~5s stereo
# 44.1kHz WAV, so audio.py has something legitimate to normalise, encode,
# probe and hash.
STUB_WAV_PATH = Path("/opt/rithm/fixtures/stub.wav")

# Simulated GPU wall-clock. Long enough for Gate C to observe queued→running
# on the SSE stream before completion lands, short enough not to slow the gate.
_STUB_INFERENCE_SECONDS = 10


def load_acestep_model() -> Any:
    """
    Load the model once per task. Stub → None.

    Day 3 loads ACE-Step v1.5 from settings.acestep_weights_dir onto cuda in
    fp16, using the shape the Track-C PoC confirms.
    """
    if get_settings().rithm_stub_inference:
        logger.info("model_load_skipped_stub")
        return None

    # Guarded import: the stub image has no CUDA and no torch wheel, so this
    # must never be hoisted to module scope. Unresolved at type-check time
    # because torch lives in the optional `gpu` dependency group.
    import torch  # noqa: F401  # pyright: ignore[reportMissingImports, reportUnusedImport]

    raise NotImplementedError(
        "real model load lands Day 3 from PoC findings"
    )


def run_inference(model: Any, job: dict[str, Any]) -> Path:
    """
    Generate audio for one job. Returns a path to a WAV on local disk.

    Day 3 dispatches on job["kind"] — generate / variation / refine_fresh, and
    refine_audio only if the PoC greenlights the reference path.
    """
    if get_settings().rithm_stub_inference:
        time.sleep(_STUB_INFERENCE_SECONDS)
        handle, name = tempfile.mkstemp(suffix=".wav")
        os.close(handle)
        dst = Path(name)
        shutil.copy(STUB_WAV_PATH, dst)
        logger.info("stub_inference_complete", job_id=job.get("job_id"))
        return dst

    raise NotImplementedError(
        "real inference lands Day 3 from PoC findings"
    )
