"""
Receive-time visibility must come from settings, not a constant.

The queue's own default is 300s. A real generation plus model warm-up plus
loudnorm plus mp3 encode plus a ~60MB WAV upload can exceed that, and when it
does SQS redelivers a job that is still running. The claim guard makes the
redelivery harmless, but it burns one of three receives — and three of those
send a healthy job to the DLQ and page someone at 3am. The GPU taskdef sets
900; this is the code that lets it take effect.
"""

from typing import Any

import pytest

from worker import aws, messaging
from worker.config import get_settings


class RecordingSQS:
    def __init__(self) -> None:
        self.receive_kwargs: dict[str, Any] = {}

    def receive_message(self, **kwargs: Any) -> dict[str, Any]:
        self.receive_kwargs = kwargs
        return {}


@pytest.fixture
def recording_sqs(monkeypatch: pytest.MonkeyPatch) -> RecordingSQS:
    sqs = RecordingSQS()
    monkeypatch.setattr(aws, "sqs", lambda: sqs)
    return sqs


def test_visibility_timeout_defaults_to_300(recording_sqs: RecordingSQS) -> None:
    assert messaging.receive_one() is None
    assert recording_sqs.receive_kwargs["VisibilityTimeout"] == 300


def test_visibility_timeout_reads_from_settings(
    recording_sqs: RecordingSQS, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SQS_VISIBILITY_TIMEOUT_SECONDS", "900")
    get_settings.cache_clear()

    assert messaging.receive_one() is None
    assert recording_sqs.receive_kwargs["VisibilityTimeout"] == 900


def test_long_poll_stays_at_the_sqs_maximum(recording_sqs: RecordingSQS) -> None:
    """20s is the ceiling; anything lower burns ReceiveMessage calls while idle."""
    messaging.receive_one()
    assert recording_sqs.receive_kwargs["WaitTimeSeconds"] == 20
    assert recording_sqs.receive_kwargs["MaxNumberOfMessages"] == 1
