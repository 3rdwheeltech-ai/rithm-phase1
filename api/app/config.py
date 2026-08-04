from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# Single source of truth for the API version — used by the FastAPI app, the
# /health payload, and the startup log line.
API_VERSION = "0.1.0"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Runtime environment
    environment: str = "local"  # local | prod — drives SSL, docs visibility, etc.

    # Browser origins allowed to call this API cross-origin, comma-separated.
    # This exists ONLY so `npm run dev` on localhost:5173 works. Production is
    # SAME-ORIGIN — CloudFront serves the SPA at / and proxies /api/* to the
    # ALB — so prod needs no entry here at all. Do not add the CloudFront
    # domain "to be safe", and never a wildcard: with allow_credentials a
    # browser rejects "*" outright, so it is a silent breakage, not a shortcut.
    cors_allowed_origins: str = "http://localhost:5173"

    # Database — one DSN per bounded-context module
    # Format: postgresql+asyncpg://user:pw@host:port/dbname
    db_identity_dsn: SecretStr
    db_catalog_dsn: SecretStr
    db_generation_dsn: SecretStr
    db_conversation_dsn: SecretStr
    db_personalization_dsn: SecretStr
    db_require_ssl: bool = False  # true when targeting RDS (asyncpg ssl + sslmode)

    # AWS infrastructure
    aws_region: str = "us-east-1"
    aws_endpoint_url: str | None = None  # set to LocalStack URL in local/test envs
    assets_bucket: str
    sqs_jobs_queue_url: str
    sns_completions_topic_arn: str
    cloudfront_distribution_domain: str = ""
    cloudfront_signing_key_pair_id: str = ""
    cloudfront_signing_key: SecretStr = SecretStr("")

    # Cognito
    cognito_user_pool_id: str = ""
    cognito_app_client_id: str = ""
    # App client was created WITH a secret — every Cognito call must send a
    # SECRET_HASH computed from it (see identity/service.py).
    cognito_app_client_secret: SecretStr = SecretStr("")

    # Bedrock + OpenAI
    bedrock_haiku_model_id: str = "anthropic.claude-3-haiku-20240307-v1:0"
    openai_api_key: SecretStr = SecretStr("")

    # Operational knobs
    log_level: str = "INFO"
    # 1800, not 300. A cold start is minutes and a 5-minute token is shorter
    # than the wait it exists to cover: the first generation of a session can
    # outlive its own stream token, so a single reconnect after a wifi blip
    # 401s permanently and the user watches a spinner forever. It cannot
    # reproduce locally, because local has no cold start.
    sse_token_ttl_seconds: int = 1800
    sse_token_secret: SecretStr = SecretStr("dev-sse-secret-change-me")
    rate_limit_per_24h: int = 20
    # The API-side length ceiling, mirroring the worker's. On the schema the
    # bound is a static le=180; this is the runtime check on top, so the cap can
    # be lowered from the PoC's findings via env without a deploy.
    max_length_seconds: int = 180

    # Stuck-job sweeper. Replaces the never-read stuck_job_timeout_minutes:
    # mixing minutes and seconds across two thresholds is exactly the confusion
    # that makes someone set the QUEUED bound thirty times too low.
    sweeper_enabled: bool = True
    sweeper_interval_seconds: int = 300
    stuck_running_seconds: int = 600
    # MUST comfortably exceed cold start + queue wait + max generation, and it
    # is a floor rather than a suggestion: lower it and you fail healthy jobs
    # while capacity is still booting. 1800 was sized against a >12 GB GPU
    # worker image. The PoC moved ACE-Step behind HTTP, so the worker image is
    # now ~250 MB and its cold start is a fraction of that — but the ACE-Step
    # SERVER's own start-up moved into the same window, and nobody has measured
    # it yet. Leaving 1800 until J4 produces a real number: too generous only
    # delays a failure the user can already see on the stream.
    stuck_queued_seconds: int = 1800

    # What the `queued` SSE frame advertises so a cold start does not read as
    # hung. Tri sets the real number from the Gate D baseline. Expect this to
    # come DOWN sharply now the worker no longer pulls a multi-gigabyte CUDA
    # image — measure it, do not extrapolate from the old estimate.
    estimated_cold_start_seconds: int = 300

    # Dev-only routes (/internal/dev/*). Guarded at include_router() time in
    # main.py, never with an `if` inside a handler — an unmounted route cannot
    # be reached by accident. MUST be absent/false in the production taskdef.
    rithm_dev_endpoints: bool = False

    # Consent
    current_consent_version: str = "tos-2026-05"


@lru_cache
def get_settings() -> Settings:
    return Settings()
