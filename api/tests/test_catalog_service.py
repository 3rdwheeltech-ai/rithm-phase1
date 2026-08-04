"""
create_track_in_txn's SQL and parameter binding.

The behaviours worth pinning without a database: that it runs on the caller's
session and never commits (otherwise the atomic three-write transaction is a
fiction), that it carries the ON CONFLICT backstop, and that job kinds are
translated rather than passed through — catalog.prompt_history's CHECK
vocabulary is deliberately different from generation.jobs'.

The transaction itself, the cross-schema grant, and the unique index are proven
against real Postgres in test_catalog_live.py.
"""

import json
from uuid import UUID

import pytest

from app.modules.catalog.models import (
    GENRES,
    MOODS,
    PROMPT_KIND_FOR_JOB,
    PROMPT_KINDS,
)
from app.modules.catalog.service import CatalogService
from tests.conftest import FakeSession

_USER = UUID("01920000-0000-7000-8000-0000000000bb")
_JOB = UUID("01920000-0000-7000-8000-00000000abcd")

_PARAMS = {
    "prompt": "a warm lo-fi loop",
    "genre": "Lo-Fi",
    "mood": "Calm",
    "bpm": 90,
    "instruments": ["rhodes"],
    "vocal": False,
    "length_seconds": 30,
    "seed": None,
}


class FakeRow:
    """A Row with attribute access, matching how the service reads RETURNING."""

    def __init__(self, row_id: str) -> None:
        self.id = row_id


def _inserting_session() -> FakeSession:
    """A session whose INSERT ... RETURNING id reports a fresh row."""
    return FakeSession([[FakeRow("01920000-0000-7000-8000-00000000face")]])


async def _create(session: FakeSession, *, kind: str = "generate") -> dict[str, object]:
    return await CatalogService().create_track_in_txn(
        session,  # type: ignore[arg-type]
        user_id=_USER,
        source_job_id=_JOB,
        kind=kind,
        prompt=_PARAMS["prompt"],  # type: ignore[arg-type]
        params=_PARAMS,
        s3_wav_key="tracks/u/j/master.wav",
        s3_mp3_key="tracks/u/j/audio.mp3",
        waveform_hash="a" * 64,
    )


@pytest.mark.asyncio
async def test_writes_track_then_prompt_history() -> None:
    session = _inserting_session()
    await _create(session)

    assert len(session.executed) == 2
    track_sql, track_params = session.executed[0]
    prompt_sql, prompt_params = session.executed[1]

    assert "INSERT INTO catalog.tracks" in track_sql
    assert "INSERT INTO catalog.prompt_history" in prompt_sql
    # The prompt row points at the track that was just inserted.
    assert prompt_params["track_id"] == track_params["id"]


@pytest.mark.asyncio
async def test_never_commits_the_callers_transaction() -> None:
    """
    The caller's context manager owns the boundary. Committing here would end
    the generation transaction early and break the all-or-nothing guarantee.
    """
    session = _inserting_session()
    await _create(session)
    assert session.commits == 0


@pytest.mark.asyncio
async def test_on_conflict_backstops_a_replayed_completion() -> None:
    session = _inserting_session()
    await _create(session)

    track_sql, _ = session.executed[0]
    assert "ON CONFLICT (source_job_id) DO NOTHING" in track_sql
    # RETURNING is what lets the caller tell "inserted" from "already there".
    assert "RETURNING id" in track_sql


@pytest.mark.asyncio
async def test_conflict_adopts_the_existing_track_and_skips_the_prompt() -> None:
    """
    On a replay the INSERT does nothing, so the id we generated was never
    written. Inserting prompt_history against it would violate the FK — the
    existing row's id has to be adopted instead.
    """
    existing_id = "01920000-0000-7000-8000-0000000000ee"
    # First execute: INSERT ... RETURNING id → no row (conflict).
    # Second execute: SELECT id ... → the row already there.
    session = FakeSession([[], [FakeRow(existing_id)]])

    created = await _create(session)

    assert str(created["track_id"]) == existing_id
    assert len(session.executed) == 2  # no prompt insert
    assert "INSERT INTO catalog.prompt_history" not in str(session.executed)
    assert "SELECT id FROM catalog.tracks" in session.executed[1][0]


@pytest.mark.asyncio
async def test_conflict_with_no_existing_row_raises() -> None:
    """DO NOTHING fired but the row is gone — only reachable if it was deleted
    mid-transaction. Raise rather than return a track id that does not exist."""
    session = FakeSession([[], []])

    with pytest.raises(RuntimeError, match="conflicted but is absent"):
        await _create(session)


@pytest.mark.asyncio
async def test_denormalizes_indexed_columns_out_of_params() -> None:
    session = _inserting_session()
    await _create(session)

    _, params = session.executed[0]
    assert params["genre"] == "Lo-Fi"
    assert params["mood"] == "Calm"
    assert params["bpm"] == 90
    assert params["vocal"] is False
    assert params["length_seconds"] == 30
    # ...while the full params still go to JSONB for reproducibility.
    assert json.loads(params["params"]) == _PARAMS


@pytest.mark.asyncio
async def test_params_are_bound_as_jsonb_not_text() -> None:
    session = _inserting_session()
    await _create(session)
    track_sql, _ = session.executed[0]
    assert "CAST(:params AS JSONB)" in track_sql


@pytest.mark.asyncio
async def test_missing_optional_params_do_not_break_the_insert() -> None:
    """A bare prompt is a valid generation; genre/mood/bpm are nullable."""
    session = _inserting_session()
    await CatalogService().create_track_in_txn(
        session,  # type: ignore[arg-type]
        user_id=_USER,
        source_job_id=_JOB,
        kind="generate",
        prompt="just a prompt",
        params={"prompt": "just a prompt", "length_seconds": 30},
        s3_wav_key="w",
        s3_mp3_key="m",
        waveform_hash="b" * 64,
    )

    _, params = session.executed[0]
    assert params["genre"] is None
    assert params["mood"] is None
    assert params["bpm"] is None
    assert params["vocal"] is True  # column default, mirrored here
    assert params["length_seconds"] == 30


@pytest.mark.asyncio
async def test_returns_the_track_id_finalize_job_puts_on_the_sse_event() -> None:
    session = _inserting_session()
    created = await _create(session)

    assert isinstance(created["track_id"], UUID)
    assert created["mp3_key"] == "tracks/u/j/audio.mp3"
    assert str(created["track_id"]) == session.executed[0][1]["id"]


@pytest.mark.parametrize(
    ("job_kind", "expected"),
    [
        ("generate", "initial"),  # the names differ on purpose
        ("variation", "variation"),
        ("refine_fresh", "refine_fresh"),
        ("refine_audio", "refine_audio"),
    ],
)
@pytest.mark.asyncio
async def test_job_kind_is_translated_to_prompt_kind(
    job_kind: str, expected: str
) -> None:
    session = _inserting_session()
    await _create(session, kind=job_kind)
    assert session.executed[1][1]["kind"] == expected


@pytest.mark.asyncio
async def test_unknown_job_kind_falls_back_to_a_valid_prompt_kind() -> None:
    """
    The CHECK constraint would reject an unmapped value, turning a completed
    generation into a rolled-back transaction. Default to `initial` instead.
    """
    session = _inserting_session()
    await _create(session, kind="something_new")
    assert session.executed[1][1]["kind"] == "initial"


def test_prompt_kind_map_only_emits_values_the_check_allows() -> None:
    assert set(PROMPT_KIND_FOR_JOB.values()) <= PROMPT_KINDS


def test_enum_lists_match_the_launch_plan() -> None:
    """These are the UI dropdown vocabularies (launch plan §A6)."""
    assert GENRES == (
        "Pop",
        "Hip-Hop",
        "EDM",
        "Lo-Fi",
        "Cinematic",
        "Rock",
        "Country",
        "R&B",
        "Ambient",
    )
    assert MOODS == (
        "Happy",
        "Calm",
        "Energetic",
        "Dark",
        "Romantic",
        "Inspirational",
        "Dramatic",
    )
