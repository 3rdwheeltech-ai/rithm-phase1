"""
The catalog read surface: list, detail, prompts, soft delete.

Two layers, because two different things can break:

  Route tests    (service patched)  — cursor round-tripping, the pagination
                                      headers Day 4 depends on, 404/204 shapes.
  Service tests  (FakeSession)      — the SQL: keyset predicate, limit+1, the
                                      CAST wrappers that stop asyncpg failing
                                      on the first page.
"""

import base64
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.modules.catalog import api as catalog_api
from app.modules.catalog import service as catalog_service_module
from app.modules.catalog.models import PromptRow, TrackRow
from app.modules.catalog.service import catalog_service
from app.shared.auth import require_user
from tests.conftest import FakeSession

USER_ID = UUID("00000000-0000-7000-8000-0000000000f1")


def _track(index: int = 0, **overrides: Any) -> TrackRow:
    created = datetime(2026, 8, 1, 12, 0, tzinfo=UTC) - timedelta(minutes=index)
    defaults: dict[str, Any] = {
        "id": UUID(int=index + 1),
        "user_id": USER_ID,
        "source_job_id": uuid4(),
        "genre": "Lo-Fi",
        "mood": "Calm",
        "bpm": 85,
        "vocal": False,
        "length_seconds": 30,
        "inference_steps": 60,
        "prompt": f"track {index}",
        "lyrics": None,
        "ref_audio_s3_key": None,
        "s3_wav_key": f"tracks/u/{index}/master.wav",
        "s3_mp3_key": f"tracks/u/{index}/audio.mp3",
        "waveform_hash": "a" * 64,
        "created_at": created,
        "updated_at": created,
        "deleted_at": None,
    }
    return TrackRow(**{**defaults, **overrides})


def _prompt(kind: str = "initial", delta: str | None = None) -> PromptRow:
    return PromptRow(
        id=uuid4(),
        prompt="warm lo-fi piano loop",
        delta_command=delta,
        kind=kind,
        created_at=datetime(2026, 8, 1, 12, 0, tzinfo=UTC),
    )


@pytest.fixture(autouse=True)
def no_real_presign(monkeypatch: pytest.MonkeyPatch) -> None:
    """Presigning is a local signing op, but it still wants credentials."""

    def _fake_presign(key: str, expires: int = 900) -> str:
        return f"https://s3.test/{key}?X-Amz-Expires={expires}"

    monkeypatch.setattr(catalog_api, "presign_get", _fake_presign)


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


# ── GET /tracks ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_returns_summaries_with_playback_urls(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    mp3_url is on the LIST, not just the detail. Day 4 feeds Recents from here
    and the Player from mp3_url; without it every click costs a round-trip.
    """

    async def _list(**_kwargs: Any) -> tuple[list[TrackRow], bool, int]:
        return [_track(0), _track(1)], False, 2

    monkeypatch.setattr(catalog_service, "list_tracks", _list)

    response = await client.get("/api/v1/tracks")

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2
    assert body[0]["mp3_url"].endswith("X-Amz-Expires=900")
    assert body[0]["prompt"] == "track 0"
    assert response.headers["X-Total-Count"] == "2"
    # Last page: no cursor headers at all, which is how the client knows to stop.
    assert "X-Next-Cursor" not in response.headers
    assert "Link" not in response.headers


@pytest.mark.asyncio
async def test_list_emits_cursor_headers_when_more_remain(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    tracks = [_track(i) for i in range(3)]

    async def _list(**_kwargs: Any) -> tuple[list[TrackRow], bool, int]:
        return tracks, True, 25

    monkeypatch.setattr(catalog_service, "list_tracks", _list)

    response = await client.get("/api/v1/tracks?limit=3")

    assert response.headers["X-Total-Count"] == "25"
    cursor = response.headers["X-Next-Cursor"]
    # Both headers carry the same cursor. Link is RFC-correct and stays;
    # X-Next-Cursor is what stops Day 4 writing an RFC 8288 parser in a hook.
    assert cursor in response.headers["Link"]
    assert 'rel="next"' in response.headers["Link"]

    # The cursor points at the LAST row of this page, so page 2 continues from
    # it with no overlap and no gap.
    decoded = base64.urlsafe_b64decode(cursor.encode()).decode()
    timestamp, _, track_id = decoded.partition("|")
    assert UUID(track_id) == tracks[-1].id
    assert datetime.fromisoformat(timestamp) == tracks[-1].created_at


@pytest.mark.asyncio
async def test_list_round_trips_its_own_cursor(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Page 2 must arrive at the service as a decoded (timestamp, id) pair."""
    seen: dict[str, Any] = {}

    async def _list(**kwargs: Any) -> tuple[list[TrackRow], bool, int]:
        seen.update(kwargs)
        return [_track(0)], True, 25

    monkeypatch.setattr(catalog_service, "list_tracks", _list)

    first = await client.get("/api/v1/tracks?limit=1")
    cursor = first.headers["X-Next-Cursor"]
    await client.get(f"/api/v1/tracks?limit=1&cursor={cursor}")

    assert seen["cursor"] == (_track(0).created_at, _track(0).id)
    assert seen["limit"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("cursor", ["not-base64!!", "Zm9vYmFy", "%%%"])
async def test_malformed_cursor_is_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, cursor: str
) -> None:
    """
    400, not a 500 and NOT a silent reset to page 1 — a silent reset leaves the
    client looping over page 1 believing it is paging forward.
    """

    async def _list(**_kwargs: Any) -> tuple[list[TrackRow], bool, int]:
        raise AssertionError("service must not be reached on a bad cursor")

    monkeypatch.setattr(catalog_service, "list_tracks", _list)

    response = await client.get(f"/api/v1/tracks?cursor={cursor}")
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_empty_cursor_means_first_page(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, Any] = {}

    async def _list(**kwargs: Any) -> tuple[list[TrackRow], bool, int]:
        seen.update(kwargs)
        return [], False, 0

    monkeypatch.setattr(catalog_service, "list_tracks", _list)

    assert (await client.get("/api/v1/tracks?cursor=")).status_code == 200
    assert seen["cursor"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [0, 101, -1])
async def test_limit_is_bounded(client: AsyncClient, limit: int) -> None:
    assert (await client.get(f"/api/v1/tracks?limit={limit}")).status_code == 422


# ── GET /tracks/{id} ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_detail_includes_ascending_prompt_history(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _get(**_kwargs: Any) -> TrackRow:
        return _track(0)

    async def _history(**_kwargs: Any) -> list[PromptRow]:
        return [_prompt(), _prompt("refine_fresh", "make it darker")]

    monkeypatch.setattr(catalog_service, "get_track", _get)
    monkeypatch.setattr(catalog_service, "get_prompt_history", _history)

    body = (await client.get(f"/api/v1/tracks/{uuid4()}")).json()

    assert body["wav_url"].endswith("X-Amz-Expires=900")
    assert body["mp3_url"].endswith("X-Amz-Expires=900")
    assert body["waveform_hash"] == "a" * 64
    assert [entry["kind"] for entry in body["prompt_history"]] == [
        "initial",
        "refine_fresh",
    ]
    assert body["prompt_history"][0]["delta_command"] is None
    assert body["prompt_history"][1]["delta_command"] == "make it darker"
    # PE-06 is cut; a structurally-always-null field is a lie Day 4 would model.
    assert "feedback" not in body


@pytest.mark.asyncio
async def test_detail_carries_lyrics_but_the_list_does_not(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    The words a track was made from are readable, and only from the detail.

    The column was written from Day 3 and serialized by nothing, so there was no
    way to confirm what a track had actually been generated with — which is
    exactly what made a worker silently dropping lyrics invisible from outside.
    Detail-only because lyrics run to 3000 characters and no list row shows them.
    """
    words = "[verse]\nCity lights are fading slow\n[chorus]\nChasing echoes"

    async def _get(**_kwargs: Any) -> TrackRow:
        return _track(0, vocal=True, lyrics=words)

    async def _history(**_kwargs: Any) -> list[PromptRow]:
        return [_prompt()]

    async def _list(**_kwargs: Any) -> tuple[list[TrackRow], bool, int]:
        return [_track(0, vocal=True, lyrics=words)], False, 1

    monkeypatch.setattr(catalog_service, "get_track", _get)
    monkeypatch.setattr(catalog_service, "get_prompt_history", _history)
    monkeypatch.setattr(catalog_service, "list_tracks", _list)

    detail = (await client.get(f"/api/v1/tracks/{uuid4()}")).json()
    assert detail["lyrics"] == words

    summary = (await client.get("/api/v1/tracks")).json()[0]
    assert "lyrics" not in summary


@pytest.mark.asyncio
async def test_detail_lyrics_are_null_when_the_model_wrote_them(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Null is a real state, not a missing field — the client has to model it."""

    async def _get(**_kwargs: Any) -> TrackRow:
        return _track(0)

    async def _history(**_kwargs: Any) -> list[PromptRow]:
        return [_prompt()]

    monkeypatch.setattr(catalog_service, "get_track", _get)
    monkeypatch.setattr(catalog_service, "get_prompt_history", _history)

    body = (await client.get(f"/api/v1/tracks/{uuid4()}")).json()
    assert body["lyrics"] is None


@pytest.mark.asyncio
async def test_detail_of_a_foreign_or_missing_track_is_404(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _get(**_kwargs: Any) -> TrackRow | None:
        return None

    monkeypatch.setattr(catalog_service, "get_track", _get)

    assert (await client.get(f"/api/v1/tracks/{uuid4()}")).status_code == 404


@pytest.mark.asyncio
async def test_non_uuid_track_id_is_422(client: AsyncClient) -> None:
    """Path params are typed UUID, which is half of why the routers cannot collide."""
    assert (await client.get("/api/v1/tracks/not-a-uuid")).status_code == 422


@pytest.mark.asyncio
async def test_prompts_route_shares_the_ownership_check(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _missing(**_kwargs: Any) -> TrackRow | None:
        return None

    monkeypatch.setattr(catalog_service, "get_track", _missing)

    response = await client.get(f"/api/v1/tracks/{uuid4()}/prompts")
    assert response.status_code == 404


# ── DELETE /tracks/{id} ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_is_204_then_404(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    A second DELETE is a 404, not a 204: the track is already gone, and
    reporting success would let a client believe it had just removed something.
    """
    outcomes = iter([True, False])

    async def _delete(**_kwargs: Any) -> bool:
        return next(outcomes)

    monkeypatch.setattr(catalog_service, "soft_delete_track", _delete)

    track_id = uuid4()
    assert (await client.delete(f"/api/v1/tracks/{track_id}")).status_code == 204
    assert (await client.delete(f"/api/v1/tracks/{track_id}")).status_code == 404


# ── Service-level: the SQL ─────────────────────────────────────────────────


def _patch_session(
    monkeypatch: pytest.MonkeyPatch, results: list[list[Any]]
) -> list[FakeSession]:
    opened: list[FakeSession] = []

    @asynccontextmanager
    async def _session(_module: str) -> AsyncIterator[FakeSession]:
        session = FakeSession(results=results)
        opened.append(session)
        yield session

    monkeypatch.setattr(catalog_service_module, "get_session", _session)
    return opened


@pytest.mark.asyncio
async def test_list_query_is_keyset_and_fetches_one_extra(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sessions = _patch_session(monkeypatch, [[], [(0,)]])

    await catalog_service.list_tracks(user_id=USER_ID, limit=10, cursor=None)

    statement, params = sessions[0].executed[0]
    # Keyset, not OFFSET: offset pagination shifts rows under the user every
    # time a generation completes, which on this product is constantly.
    assert "OFFSET" not in statement.upper()
    assert "(created_at, id) <" in statement
    assert "ORDER BY created_at DESC, id DESC" in statement
    assert "deleted_at IS NULL" in statement
    # limit+1: the extra row's existence is the has-more signal.
    assert params["limit_plus_one"] == 11
    # MANDATORY on the first page, where both cursor params are NULL — asyncpg
    # cannot infer a type for a NULL parameter without them.
    assert "CAST(:cursor_ts AS timestamptz)" in statement
    assert "CAST(:cursor_id AS uuid)" in statement
    assert params["cursor_ts"] is None


@pytest.mark.asyncio
async def test_cursor_timestamp_is_bound_as_a_datetime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    NOT an ISO string.

    The CAST types the parameter as timestamptz, and asyncpg then refuses a str
    outright — "expected a datetime.date or datetime.datetime instance". The
    CAST is still required for the first page, where the value is NULL and
    there is nothing to infer from, so both halves have to be right at once.
    A live-DB run caught this; this assertion is what stops it coming back.
    """
    sessions = _patch_session(monkeypatch, [[], [(0,)]])
    when = datetime(2026, 8, 1, 12, 0, tzinfo=UTC)

    await catalog_service.list_tracks(
        user_id=USER_ID, limit=10, cursor=(when, UUID(int=1))
    )

    _, params = sessions[0].executed[0]
    assert isinstance(params["cursor_ts"], datetime)
    assert params["cursor_ts"] == when


@pytest.mark.asyncio
async def test_list_reports_has_more_from_the_extra_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [asdict(_track(i)) for i in range(3)]
    _patch_session(monkeypatch, [rows, [(3,)]])

    tracks, has_more, total = await catalog_service.list_tracks(
        user_id=USER_ID, limit=2, cursor=None
    )

    assert len(tracks) == 2, "the extra row must not be returned to the client"
    assert has_more is True
    assert total == 3


@pytest.mark.asyncio
async def test_get_track_scopes_ownership_in_the_where_clause(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ownership in the WHERE means a miss is a clean 404 with no branch to fumble."""
    sessions = _patch_session(monkeypatch, [[]])

    assert await catalog_service.get_track(track_id=uuid4(), user_id=USER_ID) is None

    statement, _ = sessions[0].executed[0]
    assert "user_id = CAST(:user_id AS uuid)" in statement
    assert "deleted_at IS NULL" in statement


@pytest.mark.asyncio
async def test_soft_delete_folds_ownership_and_idempotency_into_one_statement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sessions = _patch_session(monkeypatch, [[(uuid4(),)]])

    assert (
        await catalog_service.soft_delete_track(track_id=uuid4(), user_id=USER_ID)
        is True
    )

    statement, _ = sessions[0].executed[0]
    assert "SET deleted_at = now()" in statement
    assert "user_id = CAST(:user_id AS uuid)" in statement
    assert "deleted_at IS NULL" in statement
    assert "RETURNING id" in statement
    # Soft, not hard: S3 objects survive and prompt_history is not cascaded away.
    assert "DELETE FROM" not in statement.upper()


@pytest.mark.asyncio
async def test_get_track_for_generation_reads_params_and_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    The one read that needs `params` — and it runs on the CATALOG connection.
    rithm_generation holds only column-scoped SELECT (id, source_job_id) and
    would be refused.
    """
    track_id, params = uuid4(), {"prompt": "p", "seed": 7}
    sessions = _patch_session(
        monkeypatch,
        [
            [
                {
                    "id": track_id,
                    "user_id": USER_ID,
                    "prompt": "warm loop",
                    "params": params,
                    "length_seconds": 30,
                }
            ]
        ],
    )

    parent = await catalog_service.get_track_for_generation(
        track_id=track_id, user_id=USER_ID
    )

    assert parent == {
        "track_id": track_id,
        "user_id": USER_ID,
        "prompt": "warm loop",
        "params": params,
        "length_seconds": 30,
    }
    statement, _ = sessions[0].executed[0]
    assert "params" in statement
    assert "user_id = CAST(:user_id AS uuid)" in statement
    assert "deleted_at IS NULL" in statement
