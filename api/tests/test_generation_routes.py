"""
The public write surface: generate, variation, refine.

These run against FakeSession rather than Postgres, deliberately — what they
assert is the SHAPE of what reaches the database and the queue: which params
land in request_payload, that the SQS envelope matches the §1 contract, that a
variation's seed differs from its parent's, and that an ownership miss enqueues
nothing. A real database proves none of that better, and Gate C already proves
the SQL runs.
"""

import json
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.modules.generation import authoring
from app.modules.generation import service as generation_service_module
from app.modules.generation.interfaces import ParentTrack
from app.modules.generation.schemas import LYRICS_MAX_LENGTH, GenerationParams
from app.modules.generation.service import generation_service
from app.shared.auth import require_user
from tests.conftest import FakeSession

USER_ID = UUID("00000000-0000-7000-8000-0000000000f1")
OTHER_USER_ID = UUID("00000000-0000-7000-8000-0000000000f2")
PARENT_TRACK_ID = UUID("00000000-0000-7000-8000-0000000000a1")

PARENT_PARAMS: dict[str, Any] = {
    "prompt": "warm lo-fi piano loop",
    "title": "Vinyl Rain",
    "voice": "female",
    "genre": "Lo-Fi",
    "mood": "Calm",
    "bpm": 85,
    "bpm_min": 80,
    "bpm_max": 90,
    "instruments": ["piano"],
    "vocal": False,
    "length_seconds": 30,
    "seed": 111,
}

GENERATE_BODY: dict[str, Any] = {
    "prompt": "warm lo-fi piano loop with soft vinyl crackle",
    "genre": "Lo-Fi",
    "mood": "Calm",
    "bpm_min": 80,
    "bpm_max": 90,
    "instruments": ["piano"],
    "vocal": False,
    "lyrics_mode": "instrumental",
    "length_seconds": 30,
}

# The same request as a SUNG one. Every lyric assertion below starts here.
SUNG_BODY: dict[str, Any] = {
    **GENERATE_BODY,
    "vocal": True,
    "lyrics_mode": "write",
}


class FakeTrackReader:
    """Stands in for CatalogService's read side."""

    def __init__(self, parent: ParentTrack | None) -> None:
        self._parent = parent
        self.calls: list[dict[str, UUID]] = []

    async def get_track_for_generation(
        self, *, track_id: UUID, user_id: UUID
    ) -> ParentTrack | None:
        self.calls.append({"track_id": track_id, "user_id": user_id})
        if self._parent is None:
            return None
        # Ownership lives in the query in the real implementation; mirror it.
        if self._parent["user_id"] != user_id:
            return None
        return self._parent


def _parent(user_id: UUID = USER_ID) -> ParentTrack:
    return {
        "track_id": PARENT_TRACK_ID,
        "user_id": user_id,
        "prompt": PARENT_PARAMS["prompt"],
        "params": dict(PARENT_PARAMS),
        "length_seconds": 30,
    }


@pytest.fixture
def sessions(monkeypatch: pytest.MonkeyPatch) -> list[FakeSession]:
    """Every session the service opens, with the INSERT's RETURNING scripted."""
    opened: list[FakeSession] = []

    @asynccontextmanager
    async def _session(_module: str) -> AsyncIterator[FakeSession]:
        session = FakeSession(results=[[_Row(datetime.now(UTC))]])
        opened.append(session)
        yield session

    monkeypatch.setattr(generation_service_module, "get_session", _session)
    return opened


class _Row:
    def __init__(self, created_at: datetime) -> None:
        self.created_at = created_at


@pytest.fixture
def rate_limited(monkeypatch: pytest.MonkeyPatch) -> list[FakeSession]:
    """A session whose conditional INSERT matches zero rows."""
    opened: list[FakeSession] = []

    @asynccontextmanager
    async def _session(_module: str) -> AsyncIterator[FakeSession]:
        # First result: the INSERT returns nothing (limit reached). Then the
        # count query, then the oldest-created_at query.
        session = FakeSession(results=[[], [(20,)], [_Row(datetime.now(UTC))]])
        opened.append(session)
        yield session

    monkeypatch.setattr(generation_service_module, "get_session", _session)
    return opened


@pytest.fixture
def sqs(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def _capture(*, queue_url: str, body: str, attributes: Any = None) -> str:
        sent.append({"queue_url": queue_url, "body": body, "attrs": attributes})
        return "msg-1"

    monkeypatch.setattr(generation_service_module, "send_sqs_message", _capture)
    return sent


@pytest.fixture
def app_with_user(monkeypatch: pytest.MonkeyPatch) -> Iterator[FastAPI]:
    from app.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    monkeypatch.setenv("RITHM_DEV_ENDPOINTS", "0")
    application = create_app()
    application.dependency_overrides[require_user] = lambda: USER_ID
    yield application
    get_settings.cache_clear()


@pytest_asyncio.fixture
async def client(app_with_user: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app_with_user), base_url="http://test"
    ) as http:
        yield http


def _envelope(sqs: list[dict[str, Any]]) -> dict[str, Any]:
    return json.loads(sqs[0]["body"])


# ── generate ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_generate_submits_job(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    response = await client.post("/api/v1/tracks/generate", json=GENERATE_BODY)

    assert response.status_code == 202
    body = response.json()
    assert set(body) == {"job_id", "status", "sse_url", "created_at"}
    assert body["status"] == "QUEUED"
    assert body["sse_url"].startswith(f"/api/v1/jobs/{body['job_id']}/events?")

    envelope = _envelope(sqs)
    assert envelope["schema_version"] == 1
    assert envelope["job_id"] == body["job_id"]
    assert envelope["user_id"] == str(USER_ID)
    assert envelope["kind"] == "generate"
    assert envelope["parent_track_id"] is None
    assert envelope["audio_reference_url"] is None

    params = envelope["params"]
    # The range collapsed to its midpoint, and BOTH survive.
    assert params["bpm"] == 85
    assert params["bpm_min"] == 80
    assert params["bpm_max"] == 90
    # The API always mints a seed; a null one would make the run
    # irreproducible and TTM-04 uncheckable.
    assert isinstance(params["seed"], int)
    assert params["seed"] > 0
    assert params["delta_command"] is None


@pytest.mark.asyncio
@pytest.mark.usefixtures("sqs")
async def test_generate_writes_a_queued_row(
    client: AsyncClient, sessions: list[FakeSession]
) -> None:
    await client.post("/api/v1/tracks/generate", json=GENERATE_BODY)

    statement, params = sessions[0].executed[0]
    assert "INSERT INTO generation.jobs" in statement
    assert "'QUEUED'" in statement
    # The rate check is folded INTO the insert, so there is no window between
    # counting and writing.
    assert "count(*)" in statement
    assert params["kind"] == "generate"
    assert json.loads(params["payload"])["bpm"] == 85


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("lo", "hi", "expected"),
    [(None, None, None), (80, None, 80), (None, 90, 90), (80, 90, 85)],
)
@pytest.mark.usefixtures("sessions")
async def test_bpm_resolution(
    client: AsyncClient,
    sqs: list[dict[str, Any]],
    lo: int | None,
    hi: int | None,
    expected: int | None,
) -> None:
    body = {**GENERATE_BODY, "bpm_min": lo, "bpm_max": hi}
    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    assert _envelope(sqs)["params"]["bpm"] == expected


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_inverted_bpm_range_is_rejected(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    body = {**GENERATE_BODY, "bpm_min": 120, "bpm_max": 80}
    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 422
    assert sqs == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_lyrics_reach_the_envelope_verbatim(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """
    The worker passes this straight to ACE-Step, so nothing may reshape it.

    Surrounding whitespace is the one exception — it is trimmed, because a box
    the user tabbed through is not a request to sing three spaces. Everything
    between the first and last character, structure tags and blank lines
    included, goes over byte for byte.
    """
    written = "[verse]\nNeon on the wet street\n\n[chorus]\nDrive"
    body = {**SUNG_BODY, "lyrics": written}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    assert _envelope(sqs)["params"]["lyrics"] == written

    padded = await client.post(
        "/api/v1/tracks/generate", json={**SUNG_BODY, "lyrics": f"\n  {written}  \n"}
    )

    assert padded.status_code == 202
    assert json.loads(sqs[1]["body"])["params"]["lyrics"] == written


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_lyrics_default_to_none(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """None is the instruction "write your own words" — it must survive as None."""
    response = await client.post("/api/v1/tracks/generate", json=GENERATE_BODY)

    assert response.status_code == 202
    assert _envelope(sqs)["params"]["lyrics"] is None


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_blank_lyrics_normalise_to_none(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """
    A box the user tabbed through means "write your own words", not "sing
    these three spaces" — and whitespace would otherwise reach the model.
    """
    body = {**SUNG_BODY, "lyrics": "   \n\t "}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    assert _envelope(sqs)["params"]["lyrics"] is None


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_lyrics_with_an_instrumental_are_rejected(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """
    Both occupy ACE-Step's single `lyrics` field, so one would have to silently
    win. A 422 at the edge means nobody downstream has to invent a precedence.
    """
    body = {**GENERATE_BODY, "lyrics": "sing this"}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 422
    assert sqs == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_overlong_lyrics_are_rejected(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    body = {**SUNG_BODY, "lyrics": "la " * LYRICS_MAX_LENGTH}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 422
    assert sqs == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_overlong_request_is_rejected_by_the_schema(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    body = {**GENERATE_BODY, "length_seconds": 999}
    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 422
    assert sqs == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_runtime_length_cap_is_enforced_below_the_schema_bound(
    client: AsyncClient,
    sqs: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    app_with_user: FastAPI,
) -> None:
    """
    MAX_LENGTH_SECONDS lets Tri lower the ceiling from the PoC findings without
    a deploy — a dynamic Pydantic bound would be far more trouble than it is
    worth for the same effect.
    """
    from app.config import get_settings
    from app.modules.generation import api as generation_api

    monkeypatch.setenv("MAX_LENGTH_SECONDS", "20")
    get_settings.cache_clear()
    monkeypatch.setattr(generation_api, "_settings", get_settings())

    response = await AsyncClient(
        transport=ASGITransport(app=app_with_user), base_url="http://test"
    ).post("/api/v1/tracks/generate", json=GENERATE_BODY)

    assert response.status_code == 400
    assert "20" in response.json()["detail"]
    assert sqs == []


@pytest.mark.asyncio
async def test_generate_rate_limited(
    client: AsyncClient,
    sqs: list[dict[str, Any]],
    rate_limited: list[FakeSession],
) -> None:
    """429 with a Retry-After, and crucially NO message on the queue."""
    response = await client.post("/api/v1/tracks/generate", json=GENERATE_BODY)

    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) >= 1
    assert sqs == []
    # The conditional INSERT matched zero rows, so no job row exists either.
    assert "count(*)" in rate_limited[0].executed[0][0]


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_enqueue_failure_fails_the_job_and_returns_503(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    The row is committed before the send, so an SQS failure leaves a job nothing
    will ever pick up. It must be failed immediately rather than left for the
    sweeper's 30 minutes.
    """

    async def _boom(**_kwargs: Any) -> str:
        raise RuntimeError("sqs is down")

    monkeypatch.setattr(generation_service_module, "send_sqs_message", _boom)

    response = await client.post("/api/v1/tracks/generate", json=GENERATE_BODY)

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "30"


# ── title, lyrics authoring and the singer ─────────────────────────────────

_MODEL_LYRICS = "[verse]\nHeadlights on the wet road\n\n[chorus]\nDrive it off\n"


@pytest.fixture
def bedrock(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """
    A fake `converse` in authoring's namespace.

    Patched there rather than in shared/aws so the sanitisers, the timeout
    wrapper and the prompt assembly all stay in the path — those are the parts
    that can be wrong. A moto round-trip would test botocore instead.
    """
    calls: list[dict[str, Any]] = []

    async def _converse(
        *, model_id: str, system: str, user: str, max_tokens: int, temperature: float
    ) -> str | None:
        calls.append({"model_id": model_id, "system": system, "user": user})
        # The title model gets far fewer tokens than the lyricist; that is the
        # only thing distinguishing the two calls from in here.
        return "Wet Road Nights" if max_tokens <= 20 else _MODEL_LYRICS

    monkeypatch.setattr(authoring, "converse", _converse)
    return calls


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_a_supplied_title_reaches_the_envelope_verbatim(
    client: AsyncClient, sqs: list[dict[str, Any]], bedrock: list[dict[str, Any]]
) -> None:
    """A name the user typed is never second-guessed, and costs no model call."""
    body = {**GENERATE_BODY, "title": "  Midnight Ferry  "}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    # Stripped, because a box the user tabbed through is not a name.
    assert _envelope(sqs)["params"]["title"] == "Midnight Ferry"
    assert bedrock == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_a_blank_title_is_written_by_the_model(
    client: AsyncClient, sqs: list[dict[str, Any]], bedrock: list[dict[str, Any]]
) -> None:
    body = {**GENERATE_BODY, "title": "   "}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    assert _envelope(sqs)["params"]["title"] == "Wet Road Nights"
    assert len(bedrock) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions", "bedrock")
async def test_a_lyric_brief_produces_model_lyrics(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    body = {
        **SUNG_BODY,
        "lyrics_mode": "prompt",
        "lyrics_prompt": "a late drive home after a fight nobody won",
    }

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    params = _envelope(sqs)["params"]
    assert params["lyrics"] == _MODEL_LYRICS.strip()
    assert params["lyrics_source"] == "model"
    # The brief is provenance and is kept beside the words it produced; the
    # worker reads neither.
    assert params["lyrics_prompt"] == "a late drive home after a fight nobody won"


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions", "bedrock")
async def test_an_empty_write_box_also_gets_model_lyrics(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """
    The rule is `vocal and lyrics is None`, in BOTH modes.

    Write mode's empty state has promised since Day 4 that "RITHM will write
    the words for you" with nothing behind it. This is that promise kept.
    """
    response = await client.post("/api/v1/tracks/generate", json=SUNG_BODY)

    assert response.status_code == 202
    params = _envelope(sqs)["params"]
    assert params["lyrics"] == _MODEL_LYRICS.strip()
    assert params["lyrics_source"] == "model"


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_user_lyrics_are_never_overwritten(
    client: AsyncClient, sqs: list[dict[str, Any]], bedrock: list[dict[str, Any]]
) -> None:
    written = "[verse]\nMy own words"
    body = {**SUNG_BODY, "lyrics": written}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    params = _envelope(sqs)["params"]
    assert params["lyrics"] == written
    assert params["lyrics_source"] == "user"
    # One call — the title — and no lyricist call at all.
    assert len(bedrock) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_bedrock_falling_over_still_returns_202(
    client: AsyncClient, sqs: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    THE test the whole design rests on.

    Generation is the product; the authoring model is a garnish. An outage must
    degrade to exactly the pre-Bedrock behaviour — a complete, enqueued job
    whose lyrics field ACE-Step's own planner fills — never a 500.
    """

    async def _explode(**_kwargs: Any) -> str | None:
        raise RuntimeError("bedrock is having a day")

    monkeypatch.setattr(authoring, "converse", _explode)

    response = await client.post(
        "/api/v1/tracks/generate",
        json={**SUNG_BODY, "lyrics_mode": "prompt", "lyrics_prompt": "a long drive"},
    )

    assert response.status_code == 202
    params = _envelope(sqs)["params"]
    assert params["lyrics"] is None
    assert params["lyrics_source"] == "acestep"
    # ...and the track still has a name, derived from the prompt alone.
    assert params["title"] == "Warm lo-fi piano loop with soft vinyl crackle"


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
@pytest.mark.parametrize(
    ("overrides", "why"),
    [
        ({"vocal": False, "lyrics_mode": "write"}, "vocal=false is instrumental"),
        ({"vocal": True, "lyrics_mode": "instrumental"}, "instrumental has no singer"),
        (
            {"vocal": True, "lyrics_mode": "write", "lyrics_prompt": "a brief"},
            "a brief belongs to prompt mode",
        ),
        (
            {"vocal": True, "lyrics_mode": "prompt", "lyrics": "[verse]\nwords"},
            "words belong to write mode",
        ),
    ],
)
async def test_disagreeing_lyric_fields_are_rejected(
    client: AsyncClient,
    sqs: list[dict[str, Any]],
    overrides: dict[str, Any],
    why: str,
) -> None:
    """Three text fields and two flags disagree in more ways than they agree."""
    body = {**GENERATE_BODY, **overrides}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 422, why
    assert sqs == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions", "bedrock")
async def test_an_spa_from_before_lyrics_mode_still_gets_an_instrumental(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """
    The deploy window, pinned.

    An SPA cached before lyrics_mode existed sends `vocal: false` and no mode.
    Defaulting that to WRITE and then enforcing the biconditional would 422
    every instrumental request from a stale tab — and CloudFront serves that JS
    for a while after the API rolls, so "deploy the web first" does not fix it.
    """
    body = {k: v for k, v in GENERATE_BODY.items() if k != "lyrics_mode"}
    assert body["vocal"] is False

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    params = _envelope(sqs)["params"]
    assert params["vocal"] is False
    assert params["lyrics"] is None


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions", "bedrock")
async def test_an_omitted_mode_on_a_sung_track_still_means_write(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """The shim is scoped to vocal=false; it must not disturb the WRITE default."""
    body = {k: v for k, v in SUNG_BODY.items() if k != "lyrics_mode"}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    # WRITE with an empty box, so the lyricist was asked — the §0.3 rule.
    assert _envelope(sqs)["params"]["lyrics_source"] == "model"


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions", "bedrock")
async def test_an_explicit_write_with_vocal_false_is_still_rejected(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """
    The shim reads `model_fields_set`, so it fires only on an OMITTED field.
    A client that states the contradiction outright still gets a 422 — losing
    that would make the biconditional unenforceable for every current client.
    """
    body = {**GENERATE_BODY, "lyrics_mode": "write"}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 422
    assert sqs == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions", "bedrock")
async def test_a_voice_on_an_instrumental_normalises_instead_of_422ing(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """
    A gender for a track with no singer is meaningless, not contradictory —
    and 422-ing a leftover slider position is user-hostile.
    """
    body = {**GENERATE_BODY, "voice": "male"}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    assert _envelope(sqs)["params"]["voice"] == "auto"


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions", "bedrock")
async def test_the_voice_reaches_the_envelope(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    body = {**SUNG_BODY, "voice": "female"}

    response = await client.post("/api/v1/tracks/generate", json=body)

    assert response.status_code == 202
    assert _envelope(sqs)["params"]["voice"] == "female"


# ── variation ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_variation_copies_parent_params_with_a_new_seed(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    generation_service.track_reader = FakeTrackReader(_parent())

    response = await client.post(f"/api/v1/tracks/{PARENT_TRACK_ID}/variation")

    assert response.status_code == 202
    envelope = _envelope(sqs)
    assert envelope["kind"] == "variation"
    assert envelope["parent_track_id"] == str(PARENT_TRACK_ID)

    params = envelope["params"]
    # Same prompt is the entire point of a variation.
    assert params["prompt"] == PARENT_PARAMS["prompt"]
    assert params["genre"] == "Lo-Fi"
    assert params["mood"] == "Calm"
    assert params["bpm"] == 85
    assert params["vocal"] is False
    # A variation is the SAME song: it inherits the name and the singer through
    # model_validate, and triggers no authoring call of its own.
    assert params["title"] == "Vinyl Rain"
    assert params["voice"] == "female"
    # ...and the seed is the ONLY thing that moved. TTM-04 depends on it.
    assert params["seed"] != PARENT_PARAMS["seed"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_variation_on_a_foreign_track_is_404_and_enqueues_nothing(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """404, never 403 — a 403 tells an attacker the track exists."""
    generation_service.track_reader = FakeTrackReader(_parent(OTHER_USER_ID))

    response = await client.post(f"/api/v1/tracks/{PARENT_TRACK_ID}/variation")

    assert response.status_code == 404
    assert sqs == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_variation_on_a_missing_track_is_404(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    generation_service.track_reader = FakeTrackReader(None)

    response = await client.post(f"/api/v1/tracks/{uuid4()}/variation")

    assert response.status_code == 404
    assert sqs == []


# ── refine ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_refine_composes_the_prompt(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    generation_service.track_reader = FakeTrackReader(_parent())

    response = await client.post(
        f"/api/v1/tracks/{PARENT_TRACK_ID}/refine",
        json={"delta_command": "make it darker and slower"},
    )

    assert response.status_code == 202
    envelope = _envelope(sqs)
    assert envelope["kind"] == "refine_fresh"
    assert envelope["parent_track_id"] == str(PARENT_TRACK_ID)

    params = envelope["params"]
    assert params["prompt"] == ("warm lo-fi piano loop. make it darker and slower")
    # Carried in the payload so finalize_job can write prompt_history
    # .delta_command without a second query.
    assert params["delta_command"] == "make it darker and slower"
    assert params["seed"] != PARENT_PARAMS["seed"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_refine_audio_reference_is_rejected(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    """
    Cut for launch (launch-plan §1.2). Rejected here with a written message AND
    in the worker's run_inference — two layers, so it can never reach a GPU.
    """
    generation_service.track_reader = FakeTrackReader(_parent())

    response = await client.post(
        f"/api/v1/tracks/{PARENT_TRACK_ID}/refine",
        json={
            "delta_command": "use this as a reference",
            "refinement_mode": "audio_reference",
        },
    )

    assert response.status_code == 400
    assert "fresh" in response.json()["detail"]
    assert sqs == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("sessions")
async def test_refine_on_a_foreign_track_is_404(
    client: AsyncClient, sqs: list[dict[str, Any]]
) -> None:
    generation_service.track_reader = FakeTrackReader(_parent(OTHER_USER_ID))

    response = await client.post(
        f"/api/v1/tracks/{PARENT_TRACK_ID}/refine",
        json={"delta_command": "darker"},
    )

    assert response.status_code == 404
    assert sqs == []


# ── pure functions ─────────────────────────────────────────────────────────


def test_compose_refined_prompt_is_deterministic() -> None:
    from app.modules.generation.service import compose_refined_prompt

    assert (
        compose_refined_prompt("a warm loop.", "make it darker")
        == "a warm loop. make it darker"
    )
    assert (
        compose_refined_prompt("a warm loop   ", "  make it darker  ")
        == "a warm loop. make it darker"
    )


def test_compose_refined_prompt_respects_the_prompt_bound() -> None:
    """Truncation keeps a long refinement chain inside prompt's 2000 chars."""
    from app.modules.generation.service import compose_refined_prompt

    assert len(compose_refined_prompt("x" * 1999, "y" * 500)) == 2000


def test_variation_seed_always_differs_from_the_parent() -> None:
    from app.modules.generation.service import new_seed_distinct_from

    assert new_seed_distinct_from(None) > 0
    for _ in range(200):
        assert new_seed_distinct_from(42) != 42


def test_genres_and_moods_match_the_catalog_vocabulary() -> None:
    """
    generation may not import catalog, so the two lists are written twice. This
    test lives in tests/, outside the independence contract, and is the only
    thing stopping them drifting apart on Day 4 when the UI dropdowns land.
    """
    from app.modules.catalog.models import GENRES, MOODS
    from app.modules.generation.schemas import Genre, Mood

    assert tuple(g.value for g in Genre) == GENRES
    assert tuple(m.value for m in Mood) == MOODS


def test_the_new_params_survive_model_validate_on_the_inherited_paths() -> None:
    """
    Variation and refine build their params with
    GenerationParams.model_validate({**parent["params"], ...}) and are
    otherwise untouched by this feature — which only works if the new fields
    round-trip through that call. A field that silently dropped here would
    rename every variation and lose its singer.
    """
    params = GenerationParams.model_validate(
        {**PARENT_PARAMS, "prompt": PARENT_PARAMS["prompt"], "seed": 999}
    )

    assert params.title == "Vinyl Rain"
    assert params.voice == "female"


def test_a_parent_from_before_this_feature_still_validates() -> None:
    """Every track already in the database predates all four new fields."""
    legacy = {k: v for k, v in PARENT_PARAMS.items() if k not in ("title", "voice")}

    params = GenerationParams.model_validate({**legacy, "seed": 999})

    assert params.title is None
    assert params.voice == "auto"
    assert params.lyrics_source is None
