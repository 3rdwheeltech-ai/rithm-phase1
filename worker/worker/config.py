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
        env_file=None,   # container env only; no .env baked into the image
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
    acestep_weights_dir: str = "/opt/acestep/weights"

    # Operational knobs
    log_level: str = "INFO"
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
