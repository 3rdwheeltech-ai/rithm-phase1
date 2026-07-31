"""
The worker loop.

Three shutdown paths, all converging on the same flag so an in-flight job is
never abandoned mid-upload:

  SIGTERM      ECS stopping the task (deploy, scale-in). Finish the current job,
               then exit 0.
  idle-exit    No work for WORKER_IDLE_EXIT_SECONDS. Exit so the ASG can scale
               the GPU instance to zero — that is the difference between a $0
               idle night and a $500 one. The Fargate stub service runs with 0
               (disabled), because nothing would replace a task that exited.
  spot notice  A 2-minute interruption warning from IMDS. Dead-but-harmless in
               Phase 1 (on-demand + Fargate); it becomes load-bearing the day
               capacity flips to Spot, which is a config change, not a code one.
"""
import signal
import sys
import threading
import time
import urllib.request
from types import FrameType

import structlog

from worker import messaging
from worker.aws import resolve_worker_id
from worker.config import get_settings
from worker.inference import load_acestep_model
from worker.logging_setup import configure_logging
from worker.processor import process_job

logger = structlog.get_logger()

_shutdown = threading.Event()

# IMDSv2 only — AL2023 disables v1. On Fargate there is no IMDS at all, so the
# token PUT times out and the watcher does nothing for the life of the task.
_IMDS_TOKEN_URL = "http://169.254.169.254/latest/api/token"  # noqa: S104
_IMDS_SPOT_URL = (
    "http://169.254.169.254/latest/meta-data/spot/instance-action"
)
_IMDS_TIMEOUT_SECONDS = 1.0
_SPOT_POLL_SECONDS = 5


def request_shutdown() -> None:
    _shutdown.set()


def _handle_sigterm(_signum: int, _frame: FrameType | None) -> None:
    # Only sets the flag. The loop finishes its current process_job() and then
    # falls out, so a job is never killed between S3 upload and SNS publish.
    logger.info("sigterm_received")
    request_shutdown()


def install_sigterm_handler() -> None:
    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)


def _check_spot_interruption() -> bool:
    """True if an interruption notice is posted. Never raises."""
    token_request = urllib.request.Request(  # noqa: S310 — fixed link-local URL
        _IMDS_TOKEN_URL,
        method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
    )
    with urllib.request.urlopen(  # noqa: S310
        token_request, timeout=_IMDS_TIMEOUT_SECONDS
    ) as response:
        token = response.read().decode()

    notice_request = urllib.request.Request(  # noqa: S310
        _IMDS_SPOT_URL, headers={"X-aws-ec2-metadata-token": token}
    )
    with urllib.request.urlopen(  # noqa: S310
        notice_request, timeout=_IMDS_TIMEOUT_SECONDS
    ) as response:
        return bool(response.status == 200)


def start_spot_watcher() -> None:
    """
    Daemon thread polling IMDS for a spot interruption notice.

    Every failure mode here is swallowed on purpose. On Fargate the token PUT
    times out; on on-demand EC2 the notice endpoint 404s. Neither is a problem,
    and an IMDS exception must never take down a worker that is mid-generation.
    """

    def loop() -> None:
        while not _shutdown.is_set():
            try:
                if _check_spot_interruption():
                    logger.warning("spot_interruption")
                    request_shutdown()
                    return
            except Exception:  # noqa: BLE001 — no IMDS / on-demand: nothing to do
                pass
            time.sleep(_SPOT_POLL_SECONDS)

    threading.Thread(target=loop, daemon=True, name="spot-watcher").start()


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    install_sigterm_handler()
    start_spot_watcher()

    worker_id = resolve_worker_id()
    model = load_acestep_model()   # None in stub
    logger.info(
        "worker_started",
        worker_id=worker_id,
        stub=settings.rithm_stub_inference,
        idle_exit_seconds=settings.worker_idle_exit_seconds,
    )

    idle_since = time.monotonic()

    while not _shutdown.is_set():
        message = messaging.receive_one()   # 20s long-poll

        if message is None:
            idle_limit = settings.worker_idle_exit_seconds
            if idle_limit > 0 and time.monotonic() - idle_since > idle_limit:
                logger.info("idle_exit")
                break
            continue

        idle_since = time.monotonic()
        process_job(message, model, worker_id)

    logger.info("worker_shutdown_clean")
    sys.exit(0)


if __name__ == "__main__":
    main()
