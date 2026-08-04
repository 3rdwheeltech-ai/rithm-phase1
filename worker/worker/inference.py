"""
The inference seam — and only this seam.

Everything else in the worker is production code that Gate C exercised for real
on the stub. That is the entire point of the stub build: the model call is the
only line in the pipeline that the stub does not prove.

Three things live here and nowhere else: the `MusicModel` Protocol, the
ACE-Step adapter, and the job-kind dispatch. Every ACE-Step-specific name is
confined to `AceStepHttpModel` and `load_acestep_model`, so if the server's
contract turns out to be slightly different, exactly one class changes and
nothing else in the worker knows the difference.

ACE-STEP IS AN HTTP SERVER, NOT A PYTHON IMPORT
-----------------------------------------------
The Track-C PoC settled this. ACE-Step v1.5 is a git checkout with its own
`uv sync` and its own HTTP surface — there is no in-process pipeline object to
construct, no Hugging Face repo id to `from_pretrained`, and consequently no
torch, no CUDA and no baked weights in THIS image. The worker is a client:

    POST /release_task   {task_type, caption, lyrics, bpm, duration,
                          batch_size, dit_model?}          -> {task_id}
    POST /query_result   {task_id_list: [task_id]}         -> {status, result,
                                                              generation_info}
                          status 1 = succeeded, 2 = failed
    GET  /v1/audio?path=<result[0].file>                   -> the audio bytes

Two consequences worth stating out loud, because they undo Day-3 assumptions:

  * The worker image no longer contains torch and does not need `GPU=1`. The
    GPU belongs to whatever runs the ACE-Step server — a sidecar container in
    the same task, or a standalone box. Either way this file only needs a URL.
  * `import torch` no longer appears anywhere in the worker.
    tests/test_inference_stub.py still asserts "torch" not in sys.modules after
    a stub run; it is now trivially true, and it stays as a tripwire against
    anyone reintroducing an in-process path without revisiting the image.

The GMC controls collapse into ACE-Step's single free-text `caption` — the
server takes no discrete genre/mood/instrument fields — and `vocal=False` is
expressed as the literal lyric `[Instrumental]`. Both are PoC findings, both
are pinned by tests, and neither is a detail to tidy.
"""
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Protocol, cast

import httpx
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

# The API resolves variation and refine at submit time, so all three arrive
# here as the same call with different envelope contents. See run_inference.
_GENERATE_KINDS = ("generate", "variation", "refine_fresh")

# /query_result status codes. Anything else means "still working" — the PoC saw
# only these two terminal values, so treating everything else as pending is the
# safe reading: a job we keep polling is recoverable, one we abandon is not.
_STATUS_SUCCEEDED = 1
_STATUS_FAILED = 2

# ACE-Step's own lyric token for "no vocals". Not a placeholder we invented.
_INSTRUMENTAL_LYRICS = "[Instrumental]"

# Below this, whatever came back is not audio. The PoC found the server can
# answer `status: succeeded` with a missing or empty file when its
# post-processing fails silently, so success is verified, never trusted.
_MIN_OUTPUT_BYTES = 1024

_NOT_CONFIGURED = (
    "ACE-Step is not configured: ACESTEP_API_BASE is empty. Point it at the "
    "ACE-Step v1.5 HTTP server (a sidecar on http://127.0.0.1:8001, or the "
    "standalone box) — the worker holds no model of its own."
)


class InferenceError(Exception):
    """
    Permanent, job-level inference failure.

    processor.py's generic `except Exception` treats this as permanent: publish
    FAILED, delete the message. It also cannot be a RetryableError even if we
    wanted one: that class lives in processor.py, and the import-linter layers
    contract puts worker.inference strictly below worker.processor. Importing
    upward is a cycle.

    That constraint is exactly why this module retries internally — see
    `_release_task` and the poll loop. Over HTTP a connection blip is genuinely
    transient, and without an in-module retry it would permanently fail a
    user's job.
    """


class MusicModel(Protocol):
    """What the rest of the worker needs a model to be. Nothing more."""

    def generate(
        self,
        *,
        prompt: str,
        genre: str | None,
        mood: str | None,
        bpm: int | None,
        instruments: list[str],
        vocal: bool,
        length_s: int,
        seed: int,
    ) -> Path: ...


def _compose_caption(
    prompt: str,
    genre: str | None,
    mood: str | None,
    instruments: list[str],
) -> str:
    """
    Collapse the user's prompt and the GMC controls into one caption.

    ACE-Step takes a single free-text `caption` — there are no discrete
    genre/mood/instrument fields to map onto (PoC intake). So the controls the
    UI presents as dropdowns have to be flattened into text here, and the ORDER
    IS A PRODUCT DECISION, not an implementation detail: it is what makes two
    identical requests produce comparable output, and it is the thing most
    likely to silently degrade quality if someone "tidies" it. That is why
    tests/test_inference_dispatch.py pins the exact output string.

    bpm and vocal are deliberately NOT in here: bpm has its own field on
    /release_task, and vocal is expressed through `lyrics`. Putting them in the
    caption as well would condition the model on the same instruction twice.
    """
    parts = [prompt.strip()]
    if genre:
        parts.append(genre)
    if mood:
        parts.append(mood)
    parts.extend(instruments)
    return ", ".join(part for part in parts if part)


def _lyrics_for(vocal: bool) -> str:
    """
    ACE-Step's vocal switch is the lyrics field, not a boolean.

    `[Instrumental]` suppresses vocals. An empty string leaves the LM planning
    phase free to write its own lyrics, which is what we want for a vocal track
    — Phase 1 has no lyrics input, so there is nothing else to send.
    """
    return _INSTRUMENTAL_LYRICS if not vocal else ""


# Decoded JSON is Any all the way down, and pyright runs strict here. These two
# narrow it ONCE, at the boundary, so every function below works with concrete
# types instead of sprinkling isinstance checks through the logic.
def _as_dict(value: Any) -> dict[str, Any] | None:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else None


def _as_list(value: Any) -> list[Any] | None:
    return cast("list[Any]", value) if isinstance(value, list) else None


def _task_state(payload: Any) -> dict[str, Any]:
    """
    Normalise a /query_result body down to the single task we asked about.

    We submit a one-element task_id_list, so the server may answer with the
    task object directly or with a one-element list of them. The PoC recorded
    the flat shape; tolerating both costs three lines and removes the one place
    a shape mismatch could otherwise burn a GPU cycle to discover. Anything
    else is reported WITH the body, so it is a two-minute fix rather than a
    guessing game.
    """
    items = _as_list(payload)
    if items is not None:
        if not items:
            raise InferenceError("ACE-Step /query_result returned an empty list")
        payload = items[0]
    state = _as_dict(payload)
    if state is None:
        raise InferenceError(
            f"unexpected /query_result body: {str(payload)[:200]}"
        )
    return state


def _reported_seed(state: dict[str, Any]) -> Any:
    """
    Dig out the seed the server actually used.

    We cannot force one (ACESTEP_SEND_SEED is off until the field name is
    confirmed), so logging what came back is the ONLY record that makes a
    generation reproducible after the fact. Cheap insurance; looked for in
    every place the PoC saw it.
    """
    candidates: list[dict[str, Any]] = [state]
    info = _as_dict(state.get("generation_info"))
    if info is not None:
        candidates.append(info)
    for entry in _as_list(state.get("result")) or []:
        entry_dict = _as_dict(entry)
        if entry_dict is not None:
            candidates.append(entry_dict)

    for candidate in candidates:
        if candidate.get("seed_value") is not None:
            return candidate["seed_value"]
    return None


def _result_file(state: dict[str, Any]) -> str:
    """
    Pull the output path out of a succeeded task, refusing an empty one.

    This is PoC gap #2 and it is the whole reason success is verified rather
    than trusted: the server can answer `status: succeeded` with an absent or
    empty `file` when its own post-processing fails. Without this check the
    worker would download nothing, hand ffmpeg an empty file, and surface a
    codec error that points nowhere near the real cause.
    """
    results = _as_list(state.get("result")) or []
    first = _as_dict(results[0]) if results else None
    remote = first.get("file") if first is not None else None
    if not remote:
        raise InferenceError(
            "ACE-Step reported the task succeeded but returned no output file "
            "— its post-processing failed silently"
        )
    return str(remote)


class AceStepHttpModel:
    """
    Adapts ACE-Step v1.5's HTTP API onto MusicModel.

    Every ACE-Step-specific field name belongs in this class and nowhere else.
    Keep the payload keys spelled exactly as the server spells them — do NOT
    tidy them into names that read better, because they have to match the
    server, not our taste.
    """

    def __init__(self, client: httpx.Client) -> None:
        settings = get_settings()
        self._client = client
        self._task_type = settings.acestep_task_type
        self._dit_model = settings.acestep_dit_model
        self._send_seed = settings.acestep_send_seed
        self._poll_interval = settings.acestep_poll_interval_seconds
        self._poll_base = settings.acestep_poll_timeout_base_seconds
        self._poll_slope = settings.acestep_poll_timeout_per_length_second
        self._submit_attempts = max(1, settings.acestep_submit_attempts)

    def generate(
        self,
        *,
        prompt: str,
        genre: str | None,
        mood: str | None,
        bpm: int | None,
        instruments: list[str],
        vocal: bool,
        length_s: int,
        seed: int,
    ) -> Path:
        caption = _compose_caption(prompt, genre, mood, instruments)
        payload: dict[str, Any] = {
            "task_type": self._task_type,
            "caption": caption,
            "lyrics": _lyrics_for(vocal),
            "duration": length_s,
            "batch_size": 1,
        }
        if bpm is not None:
            payload["bpm"] = bpm
        if self._dit_model:
            payload["dit_model"] = self._dit_model
        if self._send_seed:
            payload["seed"] = seed

        logger.info(
            "inference_starting",
            length_s=length_s,
            caption=caption,
            task_type=self._task_type,
            # Whether OUR seed reached the model at all. When false the server
            # picks its own, and the only record of it is the seed we log on
            # completion — see _reported_seed.
            seed=seed,
            seed_sent=self._send_seed,
        )
        started = time.monotonic()

        task_id = self._release_task(payload)
        remote_path = self._await_result(task_id, length_s)
        out = self._download(remote_path)

        logger.info(
            "inference_complete",
            seconds=round(time.monotonic() - started, 1),
            task_id=task_id,
            bytes=out.stat().st_size,
        )
        return out

    # ── HTTP ──────────────────────────────────────────────────────

    def _post(self, path: str, payload: dict[str, Any]) -> Any:
        try:
            response = self._client.post(path, json=payload)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError as exc:
            raise InferenceError(
                f"ACE-Step {path} failed: {type(exc).__name__}: {exc}"[:500]
            ) from exc
        except json.JSONDecodeError as exc:
            raise InferenceError(
                f"ACE-Step {path} returned a non-JSON body: {exc}"[:500]
            ) from exc

    def _release_task(self, payload: dict[str, Any]) -> str:
        """
        Submit the job, retrying a failed handoff.

        Retried because this module cannot raise a RetryableError (see
        InferenceError) and a dropped connection on submit is the one HTTP
        failure that is both likely and completely recoverable. The generation
        itself is never re-submitted — once we hold a task_id we poll, so a
        retry here can never cost two GPU runs.
        """
        last: InferenceError | None = None
        for attempt in range(1, self._submit_attempts + 1):
            try:
                raw = self._post("/release_task", payload)
            except InferenceError as exc:
                last = exc
                logger.warning(
                    "acestep_submit_failed",
                    attempt=attempt,
                    of=self._submit_attempts,
                    error=str(exc),
                )
                if attempt < self._submit_attempts:
                    time.sleep(self._poll_interval)
                continue

            body = _as_dict(raw)
            task_id = body.get("task_id") if body is not None else None
            if not task_id:
                raise InferenceError(
                    "ACE-Step /release_task returned no task_id: "
                    f"{str(raw)[:200]}"
                )
            return str(task_id)

        assert last is not None    # the loop only exits here after a failure
        raise last

    def _poll_deadline(self, length_s: int) -> float:
        """
        Generation budget for a track of this length.

        Deliberately NOT a single constant: the LM planning phase is roughly
        flat (6-14s in the PoC) while DiT synthesis scales with duration, so a
        one-size timeout is either too tight for 180s or absurdly slack for 30s.
        """
        return self._poll_base + self._poll_slope * length_s

    def _await_result(self, task_id: str, length_s: int) -> str:
        deadline = time.monotonic() + self._poll_deadline(length_s)
        while True:
            try:
                state = _task_state(
                    self._post("/query_result", {"task_id_list": [task_id]})
                )
            except InferenceError as exc:
                # A poll that fails is NOT a job that failed — the generation is
                # still running on the server. Keep polling until the deadline
                # rather than throwing away work we have already paid for.
                logger.warning(
                    "acestep_poll_failed", task_id=task_id, error=str(exc)
                )
                state = {}

            status = state.get("status")
            if status == _STATUS_FAILED:
                detail = state.get("message") or state.get("error") or ""
                raise InferenceError(
                    f"ACE-Step reported the task failed: {detail}"[:500]
                )
            if status == _STATUS_SUCCEEDED:
                logger.info(
                    "acestep_task_succeeded",
                    task_id=task_id,
                    # The LM/DiT phase breakdown — the numbers Day 5 needs to
                    # size timeouts and set user-facing expectations.
                    generation_info=state.get("generation_info"),
                    seed_value=_reported_seed(state),
                )
                return _result_file(state)

            if time.monotonic() >= deadline:
                raise InferenceError(
                    f"ACE-Step did not finish within "
                    f"{round(self._poll_deadline(length_s))}s "
                    f"(task {task_id}, {length_s}s track)"
                )
            time.sleep(self._poll_interval)

    def _download(self, remote_path: str) -> Path:
        """
        Fetch the rendered audio to local disk for audio.py to post-process.

        The remote extension is preserved rather than forced to .wav: the
        server may hand back mp3, and letting ffmpeg see the real container is
        the difference between a clean decode and a guess.
        """
        try:
            response = self._client.get(
                "/v1/audio", params={"path": remote_path}
            )
            response.raise_for_status()
            data = response.content
        except httpx.HTTPError as exc:
            raise InferenceError(
                f"ACE-Step audio download failed: {type(exc).__name__}: {exc}"[
                    :500
                ]
            ) from exc

        suffix = Path(remote_path).suffix or ".wav"
        handle, name = tempfile.mkstemp(suffix=suffix)
        os.close(handle)
        dst = Path(name)
        dst.write_bytes(data)
        return dst


def _build_client(base_url: str, timeout: float) -> httpx.Client:
    """Factory, kept separate so tests can hand in a mock transport."""
    return httpx.Client(base_url=base_url, timeout=timeout)


def load_acestep_model() -> MusicModel | None:
    """
    Build the model client once per task. Stub → None.

    On failure this deliberately propagates: main() dies, the task exits
    non-zero, ECS restarts it. A crash-loop is expensive but VISIBLE; a worker
    that silently runs without a model is worse. There is no retry loop and no
    health check to wire — the worker has no HTTP surface, and the SQS loop
    simply does not start until this returns, which is the same guarantee by
    construction.

    The reachability probe is the HTTP-era replacement for the old
    `torch.cuda.is_available()` guard, and it buys the same thing: a
    misconfigured ACESTEP_API_BASE fails at boot with a message naming the URL,
    instead of failing on the first real job several minutes later.
    """
    settings = get_settings()
    if settings.rithm_stub_inference:
        logger.info("model_load_skipped_stub")
        return None

    base_url = settings.acestep_api_base.strip().rstrip("/")
    if not base_url:
        raise InferenceError(_NOT_CONFIGURED)

    logger.info("model_loading", base_url=base_url, mode="http")
    started = time.monotonic()
    client = _build_client(base_url, settings.acestep_http_timeout_seconds)
    try:
        # Any HTTP answer proves something is listening and speaking HTTP; a
        # 404 on / is fine. Only a transport failure is fatal.
        client.get("/")
    except httpx.HTTPError as exc:
        client.close()
        raise RuntimeError(
            f"ACE-Step server unreachable at {base_url}: "
            f"{type(exc).__name__}: {exc}"
        ) from exc

    # Tri watches for this exact line before enqueuing the first real job (Dev
    # spec J4), and Day 5 needs the elapsed number for cold-start UX. It no
    # longer carries vram_mb: this process does not own the GPU any more.
    logger.info(
        "model_loaded",
        seconds=round(time.monotonic() - started, 1),
        base_url=base_url,
        dit_model=settings.acestep_dit_model,
        mode="http",
    )
    return AceStepHttpModel(client)


def run_inference(model: MusicModel | None, job: dict[str, Any]) -> Path:
    """
    Generate audio for one job. Returns a path to a WAV on local disk.

    The dispatch collapses to a SINGLE branch, which is a deliberate deviation
    from the design doc's §4.3 pseudo-code. The API resolves everything at
    submit time: a variation's envelope already carries the parent's params
    with a fresh seed, and a refine's envelope already carries the composed
    prompt. The worker cannot tell the three apart and should not try. That
    removes `original_params` from the contract entirely, keeps the worker free
    of any catalog or S3 read, and makes `kind` pure bookkeeping — it exists
    only so finalize_job can set prompt_history.kind.

    `refine_audio` is not implemented (launch-plan §1.2). The API also rejects
    it at the edge with a 400, so this branch is unreachable in practice. Two
    layers, on purpose: the edge gives a good error, this guarantees it can
    never reach a GPU.
    """
    settings = get_settings()

    if settings.rithm_stub_inference:
        time.sleep(_STUB_INFERENCE_SECONDS)
        handle, name = tempfile.mkstemp(suffix=".wav")
        os.close(handle)
        dst = Path(name)
        shutil.copy(STUB_WAV_PATH, dst)
        logger.info("stub_inference_complete", job_id=job.get("job_id"))
        return dst

    if model is None:
        raise InferenceError("model not loaded")

    kind = job["kind"]
    if kind not in _GENERATE_KINDS:
        raise InferenceError(f"unsupported job kind: {kind}")

    params: dict[str, Any] = job["params"]
    length = int(params["length_seconds"])
    if length > settings.max_length_seconds:
        raise InferenceError(
            f"length_seconds {length} exceeds worker maximum "
            f"{settings.max_length_seconds}"
        )

    out = model.generate(
        prompt=params["prompt"],
        genre=params.get("genre"),
        mood=params.get("mood"),
        bpm=params.get("bpm"),
        instruments=params.get("instruments", []),
        vocal=params.get("vocal", True),
        length_s=length,
        seed=int(params["seed"]),
    )

    # Verify, do not trust. The model server can report success and produce
    # nothing (PoC gap #2), and an empty file handed to audio.py surfaces as an
    # ffmpeg codec error that points nowhere near the real cause. This guard
    # sits on the dispatch rather than inside the adapter so it holds for any
    # future MusicModel implementation too.
    if not out.exists() or out.stat().st_size < _MIN_OUTPUT_BYTES:
        size = out.stat().st_size if out.exists() else 0
        raise InferenceError(
            f"model returned an empty or truncated file ({size} bytes) — "
            "generation reported success but produced no audio"
        )
    return out
