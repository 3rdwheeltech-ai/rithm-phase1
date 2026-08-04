"""
The stub path must produce real audio, and must never drag torch in.

The torch assertion is now trivially true — the PoC settled that ACE-Step is an
HTTP server, so no worker module imports torch at all and neither image carries
it. The test stays as a TRIPWIRE: if someone later adds an in-process model
path, this fails and forces them to revisit the image, the task definition and
the GPU reservation together rather than one at a time.
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
    monkeypatch.delenv("ACESTEP_API_BASE", raising=False)
    get_settings.cache_clear()

    with pytest.raises(inference.InferenceError):
        inference.load_acestep_model()

    # No model handle and the flag off: refuse rather than invent audio.
    with pytest.raises(inference.InferenceError, match="model not loaded"):
        inference.run_inference(None, {"job_id": "x", "kind": "generate"})
