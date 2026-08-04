"""
The claim is the worker half of Gate C6.

`UPDATE ... WHERE status='QUEUED'` means a redelivered message for a job that is
already RUNNING or COMPLETED matches zero rows. Getting False back must be an
ordinary, quiet outcome — never an exception — because it is the *expected*
result whenever SQS does what SQS is allowed to do and delivers twice.
"""

from types import TracebackType
from typing import Any

import pytest

from worker import db

_JOB = "01920000-0000-7000-8000-0000000000aa"
_WORKER = "arn:aws:ecs:us-east-1:000000000000:task/rithm-prod/abc"


class _FakeResult:
    def __init__(self, row: tuple[str, ...] | None) -> None:
        self._row = row

    def first(self) -> tuple[str, ...] | None:
        return self._row


class _FakeConn:
    def __init__(self, rows: list[tuple[str, ...] | None]) -> None:
        self._rows = rows
        self.executed: list[tuple[str, dict[str, Any]]] = []

    def execute(self, statement: Any, params: Any = None) -> _FakeResult:
        self.executed.append((str(statement), params or {}))
        return _FakeResult(self._rows.pop(0) if self._rows else None)


class _FakeEngine:
    """Only .begin() is used; it must behave as a committing context manager."""

    def __init__(self, rows: list[tuple[str, ...] | None]) -> None:
        self.conn = _FakeConn(rows)
        self.begin_calls = 0

    def begin(self) -> "_FakeEngine":
        self.begin_calls += 1
        return self

    def __enter__(self) -> _FakeConn:
        return self.conn

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _tb: TracebackType | None,
    ) -> None:
        return None


def _patch_engine(
    monkeypatch: pytest.MonkeyPatch, rows: list[tuple[str, ...] | None]
) -> _FakeEngine:
    engine = _FakeEngine(rows)
    monkeypatch.setattr(db, "get_engine", lambda: engine)
    return engine


def test_first_claim_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_engine(monkeypatch, [(_JOB,)])
    assert db.claim_job(_JOB, _WORKER) is True


def test_second_claim_returns_false_without_raising(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Row is already RUNNING/COMPLETED, so the guarded UPDATE matches nothing.
    _patch_engine(monkeypatch, [None])
    assert db.claim_job(_JOB, _WORKER) is False


def test_claim_is_guarded_on_queued_and_bumps_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _patch_engine(monkeypatch, [(_JOB,)])
    db.claim_job(_JOB, _WORKER)

    sql, params = engine.conn.executed[0]
    assert "UPDATE generation.jobs" in sql
    assert "status = 'QUEUED'" in sql  # the idempotency guard
    assert "status     = 'RUNNING'" in sql
    assert "attempt    = attempt + 1" in sql  # drives the DEAD_LETTERED count
    assert "RETURNING id" in sql
    assert params == {"job_id": _JOB, "worker_id": _WORKER}


def test_claim_runs_in_its_own_transaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Exactly one BEGIN..COMMIT, so no connection is held across inference.
    engine = _patch_engine(monkeypatch, [(_JOB,)])
    db.claim_job(_JOB, _WORKER)
    assert engine.begin_calls == 1
    assert len(engine.conn.executed) == 1
