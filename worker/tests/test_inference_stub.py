"""
The stub path must never drag torch in.

`docker build --target stub` produces a CPU-only image with no torch wheel and
no CUDA. A module-scope `import torch` — or one that creeps above the
RITHM_STUB_INFERENCE branch during a refactor — turns that image into one that
fails on startup rather than at build time, which is a much worse place to find
out. Hence the sys.modules assertion.
"""
import sys
from pathlib import Path

import pytest

from tests.conftest import STUB_WAV
from worker import inference
from worker.config import get_settings


def test_stub_returns_a_real_playable_wav(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The 10s sleep simulates GPU wall-clock for Gate C; skip it here.
    monkeypatch.setattr(inference, "_STUB_INFERENCE_SECONDS", 0)
    monkeypatch.setattr(inference, "STUB_WAV_PATH", STUB_WAV)

    out = inference.run_inference(None, {"job_id": "x", "kind": "generate"})

    assert isinstance(out, Path)
    assert out.exists()
    assert out.suffix == ".wav"
    # A genuine RIFF/WAVE file, not a placeholder — audio.py has to be able to
    # loudnorm, encode, probe and hash it for Gate C to mean anything.
    assert out.read_bytes()[:4] == b"RIFF"
    assert out.read_bytes()[8:12] == b"WAVE"
    assert out.stat().st_size == STUB_WAV.stat().st_size
    out.unlink()


def test_torch_is_never_imported_on_the_stub_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(inference, "_STUB_INFERENCE_SECONDS", 0)
    monkeypatch.setattr(inference, "STUB_WAV_PATH", STUB_WAV)

    assert get_settings().rithm_stub_inference is True
    assert inference.load_acestep_model() is None

    out = inference.run_inference(None, {"job_id": "x", "kind": "generate"})
    out.unlink()

    assert "torch" not in sys.modules


def test_real_path_is_not_silently_a_stub(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the flag off, both entry points must refuse rather than fake it."""
    monkeypatch.setenv("RITHM_STUB_INFERENCE", "0")
    get_settings.cache_clear()

    # ModuleNotFoundError here means torch is absent (the guarded import did its
    # job); NotImplementedError means torch was present and we reached the
    # Day-3 placeholder. Either proves we did not fall through to the stub.
    with pytest.raises((NotImplementedError, ModuleNotFoundError)):
        inference.load_acestep_model()

    with pytest.raises(NotImplementedError):
        inference.run_inference(None, {"job_id": "x", "kind": "generate"})
