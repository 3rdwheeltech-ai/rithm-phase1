"""
SNS envelope shape.

The API's finalize_job reads these fields by name off the SNS Message, so a
rename here is a silent break: the handler would 200 and the job would sit at
RUNNING until the sweeper failed it. These tests pin the exact key set against
the pure builders, then check once that publishing targets the right topic.
"""

import json
from datetime import datetime
from typing import Any

from tests.conftest import TOPIC_ARN, make_message
from worker import processor

_WORKER = "arn:aws:ecs:us-east-1:000000000000:task/rithm-prod/abc"


def _job(msg: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = json.loads(msg["Body"])
    return body


def test_completed_envelope_has_exactly_the_documented_keys() -> None:
    payload = processor.build_completed_envelope(
        _job(make_message()),
        wav_key="tracks/u/j/master.wav",
        mp3_key="tracks/u/j/audio.mp3",
        duration_seconds=30,
        waveform_hash="b" * 64,
        worker_id=_WORKER,
    )

    assert set(payload) == {
        "schema_version",
        "job_id",
        "status",
        "s3_wav_key",
        "s3_mp3_key",
        "duration_seconds",
        "waveform_hash",
        "worker_id",
        "completed_at",
    }
    assert payload["schema_version"] == 1
    assert payload["status"] == "COMPLETED"
    assert payload["job_id"] == "01920000-0000-7000-8000-0000000000aa"
    assert len(payload["waveform_hash"]) == 64  # CHAR(64) in catalog.tracks
    # ISO-8601 with an offset, so the API parses it without guessing a zone.
    assert datetime.fromisoformat(payload["completed_at"]).tzinfo is not None


def test_failed_envelope_has_exactly_the_documented_keys() -> None:
    payload = processor.build_failed_envelope(
        _job(make_message()), "CUDA out of memory", "RuntimeError", _WORKER
    )

    assert set(payload) == {
        "schema_version",
        "job_id",
        "status",
        "error",
        "error_class",
        "worker_id",
        "failed_at",
    }
    assert payload["schema_version"] == 1
    assert payload["status"] == "FAILED"
    assert payload["error"] == "CUDA out of memory"
    assert payload["error_class"] == "RuntimeError"
    assert datetime.fromisoformat(payload["failed_at"]).tzinfo is not None


def test_error_is_capped_at_500_chars() -> None:
    payload = processor.build_failed_envelope(
        _job(make_message()), "x" * 5000, "RuntimeError", _WORKER
    )
    assert len(payload["error"]) == 500


def test_publishes_to_the_envelope_topic_not_a_configured_one(
    fake_aws: dict[str, Any],
) -> None:
    """
    The topic comes from the message, which is what the task role scopes and
    what lets one image serve any environment without a config change.

    Driven through process_job with an unreadable schema_version: that path
    publishes FAILED before touching the database, so it exercises real
    dispatch without needing a claim.
    """
    other = "arn:aws:sns:us-east-1:000000000000:some-other-topic"
    msg = make_message(schema_version=99)
    job = _job(msg)
    job["callback_topic_arn"] = other
    msg["Body"] = json.dumps(job)

    processor.process_job(msg, None, _WORKER)

    topic, payload = fake_aws["sns"].published[0]
    assert topic == other
    assert topic != TOPIC_ARN
    assert payload["status"] == "FAILED"
