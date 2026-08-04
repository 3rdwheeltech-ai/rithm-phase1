"""
The dispatch contract — the half of Day-3 inference that needs no GPU.

`run_inference` collapses generate / variation / refine_fresh into ONE
model.generate call, because the API resolves everything at submit time. These
tests are what pin that: if someone later re-introduces a per-kind branch, the
"all three produce identical calls" assertion fails immediately rather than at
the first divergent track nobody can explain.

Nothing here imports torch, and nothing here needs the model to exist — a fake
MusicModel recording its kwargs is a stronger statement about the contract than
a real one would be.
"""

# _compose_caption is private to inference.py and tested directly on purpose: it
# is the function most likely to silently degrade output quality, and pinning it
# through the public path would need a model server.
# pyright: reportPrivateUsage=false
from pathlib import Path
from typing import Any

import pytest

from tests.conftest import STUB_WAV
from worker import inference
from worker.config import get_settings


class RecordingModel:
    """A MusicModel that records the exact kwargs it was handed."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def generate(self, **kwargs: Any) -> Path:
        self.calls.append(kwargs)
        return STUB_WAV


@pytest.fixture
def real_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """Flag off, so run_inference takes the dispatch branch, not the stub."""
    monkeypatch.setenv("RITHM_STUB_INFERENCE", "0")
    get_settings.cache_clear()


def _job(kind: str = "generate", **param_overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "prompt": "warm lo-fi piano loop",
        "genre": "Lo-Fi",
        "mood": "Calm",
        "bpm": 85,
        "bpm_min": 80,
        "bpm_max": 90,
        "instruments": ["piano"],
        "vocal": False,
        "length_seconds": 30,
        "seed": 1839201773,
    }
    params.update(param_overrides)
    return {
        "job_id": "01920000-0000-7000-8000-0000000000aa",
        "kind": kind,
        "params": params,
    }


@pytest.mark.usefixtures("real_path")
def test_generate_passes_the_exact_kwarg_set() -> None:
    model = RecordingModel()

    inference.run_inference(model, _job())

    assert model.calls == [
        {
            "prompt": "warm lo-fi piano loop",
            "genre": "Lo-Fi",
            "mood": "Calm",
            "bpm": 85,
            "instruments": ["piano"],
            "vocal": False,
            "length_s": 30,
            "seed": 1839201773,
        }
    ]
    # bpm_min/bpm_max are carried in the envelope for fidelity but must never
    # reach the model — the scalar bpm is what conditioning uses.
    assert "bpm_min" not in model.calls[0]


@pytest.mark.usefixtures("real_path")
def test_all_three_kinds_produce_an_identical_call() -> None:
    """
    kind is bookkeeping for prompt_history, nothing more.

    The API has already applied the fresh seed (variation) and the composed
    prompt (refine_fresh) before the envelope is written, so an identical
    params block must produce an identical call regardless of kind.
    """
    model = RecordingModel()

    for kind in ("generate", "variation", "refine_fresh"):
        inference.run_inference(model, _job(kind))

    assert model.calls[0] == model.calls[1] == model.calls[2]


@pytest.mark.usefixtures("real_path")
def test_envelope_differences_are_what_differ() -> None:
    """A variation carries a different seed; that difference must reach the model."""
    model = RecordingModel()

    inference.run_inference(model, _job("generate", seed=111))
    inference.run_inference(model, _job("variation", seed=222))

    assert model.calls[0]["seed"] == 111
    assert model.calls[1]["seed"] == 222


@pytest.mark.usefixtures("real_path")
@pytest.mark.parametrize("kind", ["refine_audio", "remix", "", "GENERATE"])
def test_unknown_kind_is_rejected(kind: str) -> None:
    """
    refine_audio is cut (launch-plan §1.2) and must never reach a GPU.

    The API rejects it at the edge with a 400 too. Two layers on purpose: the
    edge gives a good error, this guarantees it cannot be reached.
    """
    model = RecordingModel()

    with pytest.raises(inference.InferenceError, match="unsupported job kind"):
        inference.run_inference(model, _job(kind))

    assert model.calls == []


@pytest.mark.usefixtures("real_path")
def test_overlong_job_is_rejected_before_the_model_is_touched() -> None:
    """The guard exists so an over-long job fails fast instead of OOMing the card."""
    model = RecordingModel()

    with pytest.raises(inference.InferenceError, match="exceeds worker maximum"):
        inference.run_inference(model, _job(length_seconds=999))

    assert model.calls == []


@pytest.mark.usefixtures("real_path")
def test_length_cap_is_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tri lowers MAX_LENGTH_SECONDS from the PoC findings without a deploy."""
    monkeypatch.setenv("MAX_LENGTH_SECONDS", "20")
    get_settings.cache_clear()
    model = RecordingModel()

    with pytest.raises(inference.InferenceError, match="exceeds worker maximum"):
        inference.run_inference(model, _job(length_seconds=30))


@pytest.mark.usefixtures("real_path")
def test_missing_model_refuses_rather_than_faking_it() -> None:
    with pytest.raises(inference.InferenceError, match="model not loaded"):
        inference.run_inference(None, _job())


@pytest.mark.usefixtures("real_path")
def test_an_empty_output_file_is_refused(tmp_path: Path) -> None:
    """
    PoC gap #2: the model server can report success and produce nothing.

    The guard lives on the dispatch rather than inside the HTTP adapter so it
    holds for any MusicModel. Without it, audio.py gets a zero-byte file and
    the user sees an ffmpeg codec error that points nowhere near the cause.
    """
    empty = tmp_path / "silence.wav"
    empty.write_bytes(b"")

    class EmptyModel:
        def generate(self, **_kwargs: Any) -> Path:
            return empty

    with pytest.raises(inference.InferenceError, match="empty or truncated"):
        inference.run_inference(EmptyModel(), _job())


def test_compose_caption_is_pinned() -> None:
    """
    The caption order is a product decision, not an implementation detail.

    ACE-Step has no discrete genre/mood/instrument fields — the PoC settled
    that they all collapse into one free-text caption — so this string IS the
    conditioning. Two identical requests must produce comparable output, which
    means it cannot drift. Do not quietly reorder it.
    """
    assert (
        inference._compose_caption(
            "warm lo-fi piano loop", "Lo-Fi", "Calm", ["piano", "rhodes"]
        )
        == "warm lo-fi piano loop, Lo-Fi, Calm, piano, rhodes"
    )


def test_compose_caption_omits_absent_controls() -> None:
    assert inference._compose_caption("just a prompt", None, None, []) == (
        "just a prompt"
    )
    assert inference._compose_caption("  padded  ", "EDM", None, []) == ("padded, EDM")


def test_caption_carries_neither_bpm_nor_vocal() -> None:
    """
    Both have dedicated channels — `bpm` is its own field and `vocal` is
    expressed through `lyrics`. Repeating them in the caption would condition
    the model on the same instruction twice.
    """
    caption = inference._compose_caption("a track", "Lo-Fi", "Calm", ["piano"])

    assert "bpm" not in caption
    assert "vocal" not in caption
    assert "instrumental" not in caption
