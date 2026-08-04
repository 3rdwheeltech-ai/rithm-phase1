"""
Shared test doubles.

Hand-rolled fakes rather than moto, matching the API tree's stated reasoning:
a moto round-trip tests botocore, not this worker's logic. What these tests need
to assert is *which* calls happen and in what order — particularly that a
message is deleted only on the paths that should delete it — and a recording
fake states that directly.
"""
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from worker import aws, db
from worker.config import get_settings

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
STUB_WAV = FIXTURES_DIR / "stub.wav"

TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:rithm-job-completions"
QUEUE_URL = "http://localhost:4566/000000000000/rithm-generation-jobs"


@pytest.fixture(autouse=True)
def worker_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """
    Settings are read from the process environment, and get_settings is
    lru_cached — so the cache is cleared on both sides or values either fail to
    take or leak into the next test.
    """
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("SQS_JOBS_QUEUE_URL", QUEUE_URL)
    monkeypatch.setenv("ASSETS_BUCKET", "rithm-assets-local")
    monkeypatch.setenv(
        "DB_GENERATION_DSN_SYNC", "postgresql://u:p@localhost:5433/rithm-db"
    )
    monkeypatch.setenv("RITHM_STUB_INFERENCE", "1")
    monkeypatch.setenv("WORKER_IDLE_EXIT_SECONDS", "0")
    get_settings.cache_clear()
    aws.reset_clients()
    db.reset_engine()
    yield
    get_settings.cache_clear()
    aws.reset_clients()
    db.reset_engine()


class FakeSQS:
    """Records every queue mutation so tests can assert on delete/release."""

    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.released: list[str] = []
        self.messages: list[dict[str, Any]] = []

    def receive_message(self, **_kwargs: Any) -> dict[str, Any]:
        if not self.messages:
            return {}
        return {"Messages": [self.messages.pop(0)]}

    def delete_message(self, *, ReceiptHandle: str, **_kwargs: Any) -> None:  # noqa: N803
        self.deleted.append(ReceiptHandle)

    def change_message_visibility(
        self, *, ReceiptHandle: str, **_kwargs: Any  # noqa: N803
    ) -> None:
        self.released.append(ReceiptHandle)


class FakeS3:
    def __init__(self, fail_with: Exception | None = None) -> None:
        self.uploads: list[tuple[str, str, str]] = []
        self._fail_with = fail_with

    def upload_file(
        self, filename: str, bucket: str, key: str, **kwargs: Any
    ) -> None:
        if self._fail_with is not None:
            raise self._fail_with
        content_type = kwargs.get("ExtraArgs", {}).get("ContentType", "")
        self.uploads.append((bucket, key, content_type))
        _ = filename


class FakeSNS:
    def __init__(self) -> None:
        self.published: list[tuple[str, dict[str, Any]]] = []

    def publish(self, *, TopicArn: str, Message: str) -> None:  # noqa: N803
        self.published.append((TopicArn, json.loads(Message)))


@pytest.fixture
def fake_aws(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Swap the three client factories for recording fakes."""
    sqs, s3, sns = FakeSQS(), FakeS3(), FakeSNS()
    monkeypatch.setattr(aws, "sqs", lambda: sqs)
    monkeypatch.setattr(aws, "s3", lambda: s3)
    monkeypatch.setattr(aws, "sns", lambda: sns)
    return {"sqs": sqs, "s3": s3, "sns": sns}


def make_message(
    *,
    job_id: str = "01920000-0000-7000-8000-0000000000aa",
    user_id: str = "01920000-0000-7000-8000-0000000000bb",
    kind: str = "generate",
    schema_version: int = 1,
    receipt_handle: str = "rh-1",
) -> dict[str, Any]:
    """One SQS message carrying the §A1 envelope the API actually emits."""
    body: dict[str, Any] = {
        "schema_version": schema_version,
        "job_id": job_id,
        "user_id": user_id,
        "kind": kind,
        # Day 3: the API resolves bpm to a scalar and ALWAYS mints a seed, so
        # neither is ever null on the wire. bpm_min/bpm_max ride along for
        # fidelity and are ignored by the worker.
        "params": {
            "prompt": "stub test tone",
            "genre": None,
            "mood": None,
            "bpm": None,
            "bpm_min": None,
            "bpm_max": None,
            "instruments": [],
            "vocal": True,
            "length_seconds": 30,
            "seed": 1839201773,
        },
        "audio_reference_url": None,
        "parent_track_id": None,
        "callback_topic_arn": TOPIC_ARN,
        "submitted_at": "2026-08-01T00:00:00+00:00",
    }
    return {"Body": json.dumps(body), "ReceiptHandle": receipt_handle}
