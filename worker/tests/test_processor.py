"""
The error taxonomy, which is what decides whether AWS retries a job.

Each test pins one row of the table in processor.py's docstring. The assertions
that matter most are the negative ones: a retryable failure must NOT delete the
message and must NOT publish, because publishing FAILED would resolve the user's
stream on a job that is about to succeed on redelivery.
"""

from pathlib import Path
from typing import Any

import pytest

from tests.conftest import TOPIC_ARN, make_message
from worker import audio, db, processor, storage
from worker.processor import RetryableError, process_job

_WORKER = "arn:aws:ecs:us-east-1:000000000000:task/rithm-prod/abc"


@pytest.fixture
def stub_pipeline(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Neutralise inference and ffmpeg; those have their own tests."""
    wav = tmp_path / "raw.wav"
    wav.write_bytes(b"RIFF----WAVEfmt ")
    norm = tmp_path / "norm.wav"
    norm.write_bytes(b"RIFF----WAVEfmt ")
    mp3 = tmp_path / "out.mp3"
    mp3.write_bytes(b"ID3")

    def fake_inference(_model: Any, _job: dict[str, Any]) -> Path:
        return wav

    def fake_loudnorm(_src: Path) -> Path:
        return norm

    def fake_encode(_src: Path) -> Path:
        return mp3

    def fake_duration(_path: Path) -> int:
        return 30

    def fake_hash(_path: Path) -> str:
        return "a" * 64

    monkeypatch.setattr(processor, "run_inference", fake_inference)
    monkeypatch.setattr(audio, "loudnorm", fake_loudnorm)
    monkeypatch.setattr(audio, "encode_mp3", fake_encode)
    monkeypatch.setattr(audio, "probe_duration_seconds", fake_duration)
    monkeypatch.setattr(audio, "waveform_sha256", fake_hash)


@pytest.fixture
def claimed(monkeypatch: pytest.MonkeyPatch) -> None:
    def always(_job_id: str, _worker_id: str) -> bool:
        return True

    monkeypatch.setattr(db, "claim_job", always)


@pytest.fixture
def not_claimed(monkeypatch: pytest.MonkeyPatch) -> None:
    def never(_job_id: str, _worker_id: str) -> bool:
        return False

    monkeypatch.setattr(db, "claim_job", never)


@pytest.mark.usefixtures("claimed", "stub_pipeline")
def test_happy_path_uploads_publishes_then_deletes(
    fake_aws: dict[str, Any],
) -> None:
    msg = make_message()
    process_job(msg, None, _WORKER)

    # ── both assets, with the literal filenames Gate C4 greps for ──
    keys = [key for _bucket, key, _ct in fake_aws["s3"].uploads]
    job_id = "01920000-0000-7000-8000-0000000000aa"
    user_id = "01920000-0000-7000-8000-0000000000bb"
    assert keys == [
        f"tracks/{user_id}/{job_id}/master.wav",
        f"tracks/{user_id}/{job_id}/audio.mp3",
    ]
    content_types = [ct for _b, _k, ct in fake_aws["s3"].uploads]
    assert content_types == ["audio/wav", "audio/mpeg"]

    # ── exactly one COMPLETED SNS message, to the topic in the envelope ──
    assert len(fake_aws["sns"].published) == 1
    topic, payload = fake_aws["sns"].published[0]
    assert topic == TOPIC_ARN
    assert payload["schema_version"] == 1
    assert payload["status"] == "COMPLETED"
    assert payload["job_id"] == job_id
    assert payload["s3_wav_key"] == keys[0]
    assert payload["s3_mp3_key"] == keys[1]
    assert payload["duration_seconds"] == 30
    assert payload["waveform_hash"] == "a" * 64
    assert payload["worker_id"] == _WORKER
    assert payload["completed_at"].startswith("2")

    assert fake_aws["sqs"].deleted == ["rh-1"]


@pytest.mark.usefixtures("not_claimed")
def test_already_claimed_deletes_and_stays_silent(
    fake_aws: dict[str, Any],
) -> None:
    process_job(make_message(), None, _WORKER)

    assert fake_aws["sqs"].deleted == ["rh-1"]
    assert fake_aws["sns"].published == []  # nothing to tell the user
    assert fake_aws["s3"].uploads == []  # no GPU spend, no upload


@pytest.mark.usefixtures("claimed", "stub_pipeline")
def test_permanent_failure_publishes_failed_then_deletes(
    fake_aws: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_args: Any, **_kwargs: Any) -> None:
        raise ValueError("model exploded")

    monkeypatch.setattr(processor, "run_inference", boom)
    process_job(make_message(), None, _WORKER)

    assert len(fake_aws["sns"].published) == 1
    _topic, payload = fake_aws["sns"].published[0]
    assert payload["status"] == "FAILED"
    assert payload["error"] == "model exploded"
    assert payload["error_class"] == "ValueError"
    assert payload["worker_id"] == _WORKER
    # Deleted on purpose: redelivering a permanent failure just burns three
    # receives on its way to the DLQ.
    assert fake_aws["sqs"].deleted == ["rh-1"]


@pytest.mark.usefixtures("claimed", "stub_pipeline")
def test_retryable_failure_neither_deletes_nor_publishes(
    fake_aws: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    def flaky(*_args: Any, **_kwargs: Any) -> None:
        raise RetryableError("S3 503 SlowDown")

    monkeypatch.setattr(storage, "upload_track_assets", flaky)
    process_job(make_message(), None, _WORKER)

    # The whole point: SQS redelivers after the 300s visibility window.
    assert fake_aws["sqs"].deleted == []
    assert fake_aws["sns"].published == []


def test_unknown_schema_version_is_permanent(
    fake_aws: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    claimed_ids: list[str] = []

    def recording_claim(job_id: str, _worker_id: str) -> bool:
        claimed_ids.append(job_id)
        return True

    monkeypatch.setattr(db, "claim_job", recording_claim)
    process_job(make_message(schema_version=2), None, _WORKER)

    _topic, payload = fake_aws["sns"].published[0]
    assert payload["status"] == "FAILED"
    assert payload["error_class"] == "SchemaVersionError"
    assert fake_aws["sqs"].deleted == ["rh-1"]
    # Rejected before the claim — an unreadable envelope must not burn an
    # attempt or move the job out of QUEUED.
    assert claimed_ids == []


@pytest.mark.usefixtures("stub_pipeline")
def test_claim_error_is_retryable(
    fake_aws: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    def unreachable(*_args: Any, **_kwargs: Any) -> bool:
        raise OSError("could not connect to server")

    monkeypatch.setattr(db, "claim_job", unreachable)
    process_job(make_message(), None, _WORKER)

    # The DB was down, not the job unclaimable. Leave it for redelivery.
    assert fake_aws["sqs"].deleted == []
    assert fake_aws["sns"].published == []


def test_unparseable_body_is_dropped(fake_aws: dict[str, Any]) -> None:
    process_job({"Body": "not json at all", "ReceiptHandle": "rh-9"}, None, _WORKER)
    # No job_id to report against, so there is nothing to publish — but it must
    # not cycle to the DLQ either.
    assert fake_aws["sqs"].deleted == ["rh-9"]
    assert fake_aws["sns"].published == []
