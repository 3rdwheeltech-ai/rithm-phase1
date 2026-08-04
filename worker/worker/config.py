"""
Worker settings.

Mirrors api/app/config.py's shape (pydantic-settings, SecretStr for secrets,
lru_cached accessor) so the two trees read their environment the same way. The
one field that must never be confused with the API's: db_generation_dsn_sync is
a psycopg2 DSN (`postgresql://...`), because the worker is synchronous. The
API's DSNs are `+asyncpg`. Crossing them fails at connect time with a driver
error that reads like a network problem.
"""

from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=None,  # container env only; no .env baked into the image
        extra="ignore",
        case_sensitive=False,
    )

    # AWS infrastructure
    aws_region: str = "us-east-1"
    sqs_jobs_queue_url: str
    assets_bucket: str

    # Local-only. Unset in prod so boto3 resolves real AWS endpoints.
    aws_endpoint_url: str | None = None

    # Database — psycopg2 (sync). RDS needs ?sslmode=require in the DSN itself:
    # psycopg2 reads SSL from the URL, unlike asyncpg's ssl= connect-arg.
    db_generation_dsn_sync: SecretStr

    # Inference
    rithm_stub_inference: bool = False

    # ACE-Step v1.5 speaks HTTP, not Python (PoC intake). These configure the
    # client in inference.py; the worker itself holds no model and needs no GPU.
    #
    # Base URL of the ACE-Step server, e.g. http://127.0.0.1:8001 for a sidecar
    # or http://<ec2-dns>:8001 for a standalone box. Empty is what tells
    # inference.py it is not configured yet: with the stub flag off and this
    # unset, model load refuses loudly at boot rather than on the first job.
    acestep_api_base: str = ""
    # The ONE field the PoC intake did not pin. Settable from the environment
    # precisely so a wrong guess is a taskdef edit, not a rebuild.
    acestep_task_type: str = "text2music"
    # Only variant the PoC exercised. Empty omits the field and takes the
    # server's default.
    acestep_dit_model: str = "acestep-v15-turbo"
    # The PoC could not confirm that /release_task accepts a seed — seed_value
    # comes back in generation_info, but forcing one client-side is unverified.
    # Default OFF: sending an unknown field risks a 422 on every job. Flip it on
    # once someone confirms the field name, and reproducible variations work.
    acestep_send_seed: bool = False
    # Per-HTTP-call ceiling. Not the generation budget — that is the poll
    # deadline below.
    acestep_http_timeout_seconds: float = 30.0
    acestep_poll_interval_seconds: float = 2.0
    # Generation wall-clock is TWO components, not one (PoC intake): the LM
    # planning phase is roughly flat at 6-14s, and the DiT synthesis phase
    # scales with duration (~2.4s@30s, 3.7s@90s, 6.8s@180s). So the deadline is
    # base + slope*duration, not a single constant. These defaults give 150s for
    # a 30s track and 300s for a 180s one — the same ceiling the gen-proxy shim
    # used, but it tightens for short jobs instead of hanging for five minutes.
    acestep_poll_timeout_base_seconds: float = 120.0
    acestep_poll_timeout_per_length_second: float = 1.0
    # /release_task is retried because a connection blip on submit would
    # otherwise fail a job permanently — InferenceError cannot be retryable
    # (processor.py owns RetryableError and is a layer above this one).
    acestep_submit_attempts: int = 3

    # The worker's own ceiling, mirroring the API's cap so an over-long job is
    # refused with a message instead of tying up the model server. PoC intake #9
    # confirms 180s is comfortable (18.4/23 GB peak, no OOM); 180 also matches
    # catalog.tracks' tracks_length_range CHECK.
    max_length_seconds: int = 180

    # Operational knobs
    log_level: str = "INFO"
    # Overrides the queue-level default at receive time. 300 is fine for the
    # stub; the GPU taskdef sets 900, because a 180s generation plus model
    # warm-up plus loudnorm plus mp3 encode plus a 60MB upload can brush past
    # 300 — and when it does, SQS redelivers a job that is still running.
    sqs_visibility_timeout_seconds: int = 300
    # Seconds of empty long-polls before the task exits so the ASG can scale in.
    # 0 disables idle-exit entirely — that is what the Fargate stub service runs
    # with, since nothing would replace a task that exited.
    worker_idle_exit_seconds: int = 600


@lru_cache
def get_settings() -> Settings:
    # pyright cannot see that BaseSettings fills required fields from the
    # environment, so it reads the no-arg call as missing arguments. A missing
    # env var still raises ValidationError at startup, which is the behaviour
    # we want — fail loudly at boot, not on the first job.
    return Settings()  # pyright: ignore[reportCallIssue]
