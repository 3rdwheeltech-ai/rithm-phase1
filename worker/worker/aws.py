"""
The worker's AWS SDK surface.

Direction is a contract, not a convenience: the worker is an SQS *consumer only*
(ReceiveMessage/DeleteMessage, never SendMessage — IAM forbids it and the API is
the sole producer), it writes S3 under tracks/* only, and it publishes SNS to
the topic carried in the job envelope rather than a configured ARN. Keeping
every SDK call behind this module is what makes that reviewable.

Unlike the API, there is no run_in_threadpool hop — the worker is synchronous,
so plain boto3 is the whole story.

Client construction is lazy so importing worker.main never reaches out to AWS,
and so tests can patch settings (or these factories) before the first call.
"""
# boto3/botocore ship no py.typed, so every call is Unknown to pyright strict.
# Containing the suppression to this one file is the whole point of the module;
# the callers below all consume concretely typed wrappers.
# pyright: reportMissingTypeStubs=false, reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false
import json
import os
import socket
import urllib.request
from typing import Any

import boto3
import structlog

from worker.config import get_settings

logger = structlog.get_logger()

_clients: dict[str, Any] = {}

# ECS injects this; anything else (local, plain EC2) leaves it unset.
_ECS_METADATA_ENV = "ECS_CONTAINER_METADATA_URI_V4"
_METADATA_TIMEOUT_SECONDS = 1.0


def _client(service: str) -> Any:
    if service not in _clients:
        settings = get_settings()
        kwargs: dict[str, Any] = {"region_name": settings.aws_region}
        if settings.aws_endpoint_url:
            # LocalStack. Unset in prod → real AWS endpoints.
            kwargs["endpoint_url"] = settings.aws_endpoint_url
        _clients[service] = boto3.client(service, **kwargs)
    return _clients[service]


def sqs() -> Any:
    return _client("sqs")


def s3() -> Any:
    return _client("s3")


def sns() -> Any:
    return _client("sns")


def reset_clients() -> None:
    """Drop cached clients. Test helper — not used at runtime."""
    _clients.clear()


def resolve_worker_id() -> str:
    """
    Identify this task for the claim UPDATE and the SNS payload.

    On ECS this is the task ARN, which is what an operator pastes into
    `aws ecs describe-tasks` when a job is stuck. Everywhere else it degrades to
    a host/pid string rather than failing — the column is VARCHAR(128) and
    purely diagnostic, so an unresolvable identity must never block a job.

    urllib rather than httpx: the metadata endpoint is hit exactly once at
    startup, and the worker image should not carry an HTTP client for it.
    """
    uri = os.getenv(_ECS_METADATA_ENV)
    if uri:
        try:
            with urllib.request.urlopen(  # noqa: S310 — fixed ECS-local URL
                f"{uri}/task", timeout=_METADATA_TIMEOUT_SECONDS
            ) as response:
                data: dict[str, Any] = json.loads(response.read())
            task_arn = data.get("TaskARN")
            if isinstance(task_arn, str) and task_arn:
                return task_arn
        except Exception:  # noqa: BLE001 — diagnostic only; never fatal
            logger.warning("worker_id_metadata_unavailable")
    return f"local:{socket.gethostname()}:{os.getpid()}"
