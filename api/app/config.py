from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Runtime environment
    environment: str = "local"   # local | prod — drives SSL, docs visibility, etc.

    # Database — one DSN per bounded-context module
    # Format: postgresql+asyncpg://user:pw@host:port/dbname
    db_identity_dsn: SecretStr
    db_catalog_dsn: SecretStr
    db_generation_dsn: SecretStr
    db_conversation_dsn: SecretStr
    db_personalization_dsn: SecretStr

    # AWS infrastructure
    aws_region: str = "us-east-1"
    aws_endpoint_url: str | None = None   # set to LocalStack URL in local/test envs
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
    sse_token_ttl_seconds: int = 300
    sse_token_secret: SecretStr = SecretStr("dev-sse-secret-change-me")
    rate_limit_per_24h: int = 20
    stuck_job_timeout_minutes: int = 10

    # Consent
    current_consent_version: str = "tos-2026-05"


@lru_cache
def get_settings() -> Settings:
    return Settings()
