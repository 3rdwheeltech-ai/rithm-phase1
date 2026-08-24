"""
The ACE-Step HTTP contract — everything the PoC pinned, pinned back.

The PoC ran ACE-Step v1.5 once, by hand, and wrote down what it saw. These
tests are the only thing standing between those notes and a silent drift: every
field name, the status codes, the instrumental token and the "success can still
mean no audio" trap are asserted here rather than discovered on a GPU.

httpx.MockTransport is used instead of a hand-rolled fake because the thing
under test IS the HTTP call — a fake client would let a wrong URL, a wrong verb
or a mis-serialised body pass unnoticed, which is exactly the class of bug this
file exists to catch.
"""

# The poll deadline and caption helpers are private and probed directly: they
# are arithmetic and string composition, and reaching them through generate()
# would prove less while taking a real timeout to do it.
# pyright: reportPrivateUsage=false
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from worker import inference
from worker.config import get_settings

BASE = "http://model.internal:8001"
AUDIO = b"RIFF" + b"\0" * 4096
Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture(autouse=True)
def fast_polling(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Real sleeps would make this file take minutes and prove nothing."""
    monkeypatch.setenv("ACESTEP_POLL_INTERVAL_SECONDS", "0")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _model(handler: Handler) -> inference.AceStepHttpModel:
    client = httpx.Client(transport=httpx.MockTransport(handler), base_url=BASE)
    return inference.AceStepHttpModel(client)


def _generate(model: inference.AceStepHttpModel, **overrides: Any) -> Path:
    kwargs: dict[str, Any] = {
        "prompt": "warm lo-fi piano loop",
        "genre": "Lo-Fi",
        "mood": "Calm",
        "bpm": 85,
        "instruments": ["piano"],
        "vocal": False,
        "length_s": 30,
        "seed": 1839201773,
    }
    kwargs.update(overrides)
    return model.generate(**kwargs)


def _patch_client(monkeypatch: pytest.MonkeyPatch, handler: Handler) -> None:
    """Swap the client factory so load_acestep_model's probe hits our handler."""

    def build(base_url: str, timeout: float) -> httpx.Client:
        _ = timeout
        return httpx.Client(transport=httpx.MockTransport(handler), base_url=base_url)

    monkeypatch.setattr(inference, "_build_client", build)


def _succeeding_handler(
    recorder: list[httpx.Request] | None = None,
    *,
    result_file: str | None = "/out/track-1.wav",
    pending_polls: int = 0,
) -> Handler:
    """Submit → N pending polls → success → audio bytes."""
    state = {"polls": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if recorder is not None:
            recorder.append(request)
        if request.url.path == "/release_task":
            return httpx.Response(200, json={"task_id": "task-abc"})
        if request.url.path == "/query_result":
            state["polls"] += 1
            if state["polls"] <= pending_polls:
                return httpx.Response(200, json={"status": 0})
            body: dict[str, Any] = {
                "status": 1,
                "result": [{"file": result_file} if result_file else {}],
                "generation_info": {
                    "lm_seconds": 8.2,
                    "dit_seconds": 2.4,
                    "seed_value": 42,
                },
            }
            return httpx.Response(200, json=body)
        if request.url.path == "/v1/audio":
            return httpx.Response(200, content=AUDIO)
        return httpx.Response(404)

    return handler


# ── /release_task ──────────────────────────────────────────────


def test_release_task_payload_matches_the_poc_contract() -> None:
    """
    Every key here was read off the PoC's working request. Renaming one to
    something that reads better breaks generation on the server, not here.
    """
    seen: list[httpx.Request] = []

    _generate(_model(_succeeding_handler(seen)))

    submit = next(r for r in seen if r.url.path == "/release_task")
    assert submit.method == "POST"
    body = json.loads(submit.content)
    assert body == {
        "task_type": "text2music",
        # GMC controls collapse into one free-text caption — there are no
        # discrete genre/mood/instrument fields on the server.
        "caption": "warm lo-fi piano loop, Lo-Fi, Calm, piano",
        "lyrics": "[Instrumental]",
        "duration": 30,
        "batch_size": 1,
        "bpm": 85,
        "dit_model": "acestep-v15-turbo",
    }


def test_vocal_tracks_without_lyrics_send_an_empty_string() -> None:
    """
    An empty lyrics field is the instruction "write your own words". It is a
    third state, not a missing value — do not let anyone "fix" it to null.
    """
    seen: list[httpx.Request] = []

    _generate(_model(_succeeding_handler(seen)), vocal=True)

    body = json.loads(seen[0].content)
    assert body["lyrics"] == ""


def test_user_lyrics_reach_the_server_verbatim() -> None:
    """
    ACE-Step parses its own structure tags, so the text goes over untouched —
    no stripping, no normalising, no wrapping.
    """
    seen: list[httpx.Request] = []
    written = "[verse]\nNeon on the wet street\n\n[chorus]\nDrive\n"

    _generate(_model(_succeeding_handler(seen)), vocal=True, lyrics=written)

    body = json.loads(seen[0].content)
    assert body["lyrics"] == written


def test_lyrics_do_not_leak_into_the_caption() -> None:
    """
    Conditioning the model on the same words twice is the failure mode the
    caption's docstring warns about. Lyrics have their own field.
    """
    seen: list[httpx.Request] = []

    _generate(_model(_succeeding_handler(seen)), vocal=True, lyrics="secret words")

    body = json.loads(seen[0].content)
    assert body["caption"] == "warm lo-fi piano loop, Lo-Fi, Calm, piano"


def test_the_requested_voice_reaches_the_caption_and_never_the_lyrics() -> None:
    """
    The gender is conditioning, not words. If it ever landed in `lyrics` it
    would either be sung or displace the vocal switch — both worse than the
    caption token it is.
    """
    seen: list[httpx.Request] = []

    _generate(_model(_succeeding_handler(seen)), vocal=True, voice="female")

    body = json.loads(seen[0].content)
    assert body["caption"] == "warm lo-fi piano loop, Lo-Fi, Calm, female vocals, piano"
    assert body["lyrics"] == ""


def test_instrumental_beats_supplied_lyrics() -> None:
    """
    The API rejects this pair with a 422, so it should never arrive — but the
    two cannot share one field, and silently singing over a request for an
    instrumental is the worse of the two ways to lose.
    """
    seen: list[httpx.Request] = []

    _generate(_model(_succeeding_handler(seen)), vocal=False, lyrics="sing this")

    assert json.loads(seen[0].content)["lyrics"] == "[Instrumental]"


def test_bpm_is_omitted_when_absent() -> None:
    seen: list[httpx.Request] = []

    _generate(_model(_succeeding_handler(seen)), bpm=None)

    assert "bpm" not in json.loads(seen[0].content)


def test_seed_is_withheld_by_default() -> None:
    """
    The PoC could not confirm /release_task accepts a seed, and sending an
    unknown field risks a 422 on every job. Off until someone verifies it.
    """
    seen: list[httpx.Request] = []

    _generate(_model(_succeeding_handler(seen)))

    assert "seed" not in json.loads(seen[0].content)


def test_seed_is_sent_once_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """One env var away, so confirming the field name needs no code change."""
    monkeypatch.setenv("ACESTEP_SEND_SEED", "1")
    get_settings.cache_clear()
    seen: list[httpx.Request] = []

    _generate(_model(_succeeding_handler(seen)), seed=777)

    assert json.loads(seen[0].content)["seed"] == 777


def test_a_missing_task_id_is_reported_with_the_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"detail": "queue full"})

    with pytest.raises(inference.InferenceError, match="no task_id"):
        _generate(_model(handler))


def test_submit_is_retried_before_the_job_is_lost() -> None:
    """
    InferenceError is permanent by construction (RetryableError lives a layer
    up), so a dropped connection on submit would otherwise fail a user's job
    outright. The generation itself is never re-submitted — once we hold a
    task_id we only poll — so this can never cost two GPU runs.
    """
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/release_task":
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise httpx.ConnectError("connection refused")
            return httpx.Response(200, json={"task_id": "task-abc"})
        return _succeeding_handler()(request)

    out = _generate(_model(handler))

    assert attempts["n"] == 3
    assert out.read_bytes() == AUDIO
    out.unlink()


def test_submit_gives_up_after_the_configured_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ACESTEP_SUBMIT_ATTEMPTS", "2")
    get_settings.cache_clear()
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        raise httpx.ConnectError("connection refused")

    with pytest.raises(inference.InferenceError, match="release_task failed"):
        _generate(_model(handler))
    assert attempts["n"] == 2


# ── /query_result ──────────────────────────────────────────────


def test_polls_until_succeeded_then_downloads_the_audio() -> None:
    seen: list[httpx.Request] = []

    out = _generate(_model(_succeeding_handler(seen, pending_polls=2)))

    polls = [r for r in seen if r.url.path == "/query_result"]
    assert len(polls) == 3
    assert json.loads(polls[0].content) == {"task_id_list": ["task-abc"]}

    download = next(r for r in seen if r.url.path == "/v1/audio")
    assert download.url.params["path"] == "/out/track-1.wav"
    assert out.read_bytes() == AUDIO
    out.unlink()


def test_a_one_element_list_body_is_accepted() -> None:
    """
    We submit a one-element task_id_list, so the server may answer with the
    task object or with a list of them. The PoC recorded the flat shape;
    tolerating both is three lines and removes a whole class of cold-start
    surprise.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/release_task":
            return httpx.Response(200, json={"task_id": "t"})
        if request.url.path == "/query_result":
            return httpx.Response(
                200, json=[{"status": 1, "result": [{"file": "/out/a.wav"}]}]
            )
        return httpx.Response(200, content=AUDIO)

    out = _generate(_model(handler))

    assert out.read_bytes() == AUDIO
    out.unlink()


def test_a_failed_status_is_permanent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/release_task":
            return httpx.Response(200, json={"task_id": "t"})
        return httpx.Response(200, json={"status": 2, "message": "out of memory"})

    with pytest.raises(inference.InferenceError, match="out of memory"):
        _generate(_model(handler))


def test_success_without_a_file_is_refused() -> None:
    """
    PoC gap #2, and the reason success is verified rather than trusted: the
    server can answer `status: succeeded` with an empty file when its own
    post-processing fails. Downloading nothing and handing ffmpeg an empty
    file produces a codec error that points nowhere near the cause.
    """
    with pytest.raises(inference.InferenceError, match="no output file"):
        _generate(_model(_succeeding_handler(result_file=None)))


def test_a_transient_poll_failure_does_not_throw_the_job_away() -> None:
    """
    A poll that fails is not a job that failed — the generation is still
    running on the server, and we have already paid for it.
    """
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/release_task":
            return httpx.Response(200, json={"task_id": "t"})
        if request.url.path == "/query_result":
            calls["n"] += 1
            if calls["n"] == 1:
                raise httpx.ReadTimeout("gateway hiccup")
            return httpx.Response(
                200, json={"status": 1, "result": [{"file": "/out/a.wav"}]}
            )
        return httpx.Response(200, content=AUDIO)

    out = _generate(_model(handler))

    assert calls["n"] == 2
    out.unlink()


def test_polling_stops_at_the_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ACESTEP_POLL_TIMEOUT_BASE_SECONDS", "0")
    monkeypatch.setenv("ACESTEP_POLL_TIMEOUT_PER_LENGTH_SECOND", "0")
    get_settings.cache_clear()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/release_task":
            return httpx.Response(200, json={"task_id": "t"})
        return httpx.Response(200, json={"status": 0})

    with pytest.raises(inference.InferenceError, match="did not finish"):
        _generate(_model(handler))


def test_the_deadline_scales_with_track_length() -> None:
    """
    Generation wall-clock is two components, not one: the LM phase is roughly
    flat (6-14s measured) and DiT scales with duration. A single constant is
    either too tight at 180s or absurdly slack at 30s.
    """
    model = _model(_succeeding_handler())

    assert model._poll_deadline(30) == 150.0
    assert model._poll_deadline(180) == 300.0


# ── load_acestep_model ─────────────────────────────────────────


def test_unconfigured_base_url_names_the_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    A half-configured image must say which variable is missing. Without it the
    failure surfaces on the first real job, minutes into a cold start.
    """
    monkeypatch.setenv("RITHM_STUB_INFERENCE", "0")
    monkeypatch.delenv("ACESTEP_API_BASE", raising=False)
    get_settings.cache_clear()

    with pytest.raises(inference.InferenceError, match="ACESTEP_API_BASE"):
        inference.load_acestep_model()


def test_an_unreachable_server_fails_at_boot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    The HTTP-era replacement for the old torch.cuda.is_available() guard, and
    it buys the same thing: a wrong URL kills the task at startup with a
    message naming it, rather than failing on the first user's job.
    """
    monkeypatch.setenv("RITHM_STUB_INFERENCE", "0")
    monkeypatch.setenv("ACESTEP_API_BASE", BASE)
    get_settings.cache_clear()

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _patch_client(monkeypatch, refuse)

    with pytest.raises(RuntimeError, match="unreachable"):
        inference.load_acestep_model()


def test_a_reachable_server_yields_a_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Any HTTP answer proves something is listening — a 404 on / is fine."""
    monkeypatch.setenv("RITHM_STUB_INFERENCE", "0")
    monkeypatch.setenv("ACESTEP_API_BASE", BASE + "/")
    get_settings.cache_clear()

    _patch_client(monkeypatch, lambda _request: httpx.Response(404))

    model = inference.load_acestep_model()

    assert isinstance(model, inference.AceStepHttpModel)
