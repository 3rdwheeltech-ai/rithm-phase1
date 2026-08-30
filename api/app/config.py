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

    # ── Bedrock (authoring: lyrics + titles) ────────────────────────────────
    # OFF by default. Local and CI take the fallback paths, which is both the
    # correct behaviour without credentials and free coverage of those paths.
    # The live rithm-api task definition sets BEDROCK_ENABLED=true.
    bedrock_enabled: bool = False
    # Cross-region inference profile, hence the `us.` prefix — Haiku 4.5 has no
    # plain on-demand foundation-model id, and invoking the bare
    # `anthropic.claude-haiku-4-5-...` returns a ValidationException that reads
    # like a typo. The prefix is load-bearing, and the task role's policy must
    # grant BOTH the profile ARN and the underlying regional model ARNs.
    #
    # This DEFAULT is the destination, not what production runs today: every
    # Anthropic model on Bedrock is gated behind a one-time per-account "use
    # case details" form, and until it is submitted this id returns
    # ResourceNotFoundException and lyrics degrade to ACE-Step. The live
    # taskdef overrides it with us.amazon.nova-2-lite-v1:0 in the meantime.
    # Remove that override once the form clears.
    bedrock_lyrics_model_id: str = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    # The cheapest text model on Bedrock. A title is ~300 tokens in and ~10 out,
    # so this line item is rounding error.
    bedrock_title_model_id: str = "amazon.nova-micro-v1:0"
    # Per-call ceiling. These sit on the submit path, in front of a 202 the user
    # is watching a button spinner for: a latency budget, not a generosity
    # setting.
    bedrock_lyrics_timeout_seconds: float = 8.0
    bedrock_title_timeout_seconds: float = 4.0

    # ── Bedrock (conversation) ──────────────────────────────────────────────
    # An ORDERED FALLBACK CHAIN, comma-separated — the shape
    # cors_allowed_origins already uses. Haiku leads because it is the model we
    # want; today it and gemma both fail in under a second (the per-account
    # Anthropic "use case details" form has not cleared, and gemma is
    # deliberately absent from the task role's Bedrock policy), so leading with
    # them costs ~350ms and buys a chain that needs no code change the day
    # either is unblocked. Nova 2 Lite therefore serves 100% of chat traffic.
    #
    # Do NOT add gemma to the IAM policy to "complete" this: it stops failing
    # fast and starts burning its full read timeout on every turn — measured
    # >10s, which is why the lyrics path rejected it. See the chat-assistant
    # plan §0.A and ops/iam/README-bedrock.md.
    bedrock_chat_model_ids: str = (
        "us.anthropic.claude-haiku-4-5-20251001-v1:0,"
        "google.gemma-3-27b-it,"
        "us.amazon.nova-2-lite-v1:0"
    )
    # A budget for the whole TURN, not per model. asyncio.wait_for cancels the
    # await, never the boto3 thread underneath run_in_threadpool, and anyio's
    # default limiter is 40 threads SHARED with send_sqs_message on the generate
    # path — so three orphaned 10s threads per chat turn is a way to stall
    # generation. A timeout therefore ENDS the chain; it does not advance it.
    bedrock_chat_timeout_seconds: float = 20.0
    # Strictly ABOVE the budget above: botocore cutting in first would surface
    # as a ClientError, which the chain would misread as a structural refusal
    # and advance on — stacking a second orphaned thread on the same limiter.
    bedrock_chat_read_timeout_seconds: int = 22
    # The extractor. Already the title model, already IAM-granted and enabled,
    # and its 4s precedent budget is the right order of magnitude for the ~200
    # tokens of JSON this asks for. Deliberately NOT on the chain above: "can
    # hold a conversation" and "can emit strict JSON" are different jobs.
    bedrock_extract_model_id: str = "amazon.nova-micro-v1:0"
    bedrock_extract_timeout_seconds: float = 6.0
    # tiktoken, not a message count. messages.token_count exists for exactly
    # this, and a fixed "last N messages" blows the context window the first
    # time someone pastes a verse into the chat.
    chat_history_token_budget: int = 3000
    chat_max_messages_per_session: int = 60  # then 409 — start a new session
    chat_max_messages_per_day: int = 200  # then 429 — the spend cap

    # ── Anam (voice avatar) ─────────────────────────────────────────────────
    # Off by default, exactly like bedrock_enabled: local, CI and any
    # environment that has not been given a key get today's Lottie avatar and a
    # Talk button that opens Coming Soon, with no branch on `environment`
    # anywhere.
    anam_enabled: bool = False
    anam_api_key: SecretStr = SecretStr("")
    anam_api_base: str = "https://api.anam.ai/v1"

    # The persona, passed as personaConfig at mint time rather than referenced
    # by personaId — see conversation/anam.py.
    #
    # avatar_id is "Ria", from the Ria-rithm persona. It is ORG-OWNED, and that
    # is the sharp edge: it exists only in the Anam org the current key belongs
    # to. The previous value here (3fff7cca…, "Flowerva") belonged to a
    # DIFFERENT org and stopped existing the moment the key was rotated to a
    # new account.
    #
    # And nothing catches that for you. POST /auth/session-token returns 200
    # for an avatar id the key cannot see — the mint validates the body shape
    # and the key, NOT the avatar. So a wrong id here sails past the boot
    # guard, past the mint, and fails in the browser at connect time. Whenever
    # the key moves to a new account, re-check this against:
    #   curl -s "https://api.anam.ai/v1/avatars?perPage=200" \
    #     -H "Authorization: Bearer $ANAM_API_KEY" \
    #     | jq '[.data[] | select(.createdByOrganizationId != null)]'
    anam_avatar_id: str = "317c3c80-70c0-4cd7-8f54-2668dd442624"
    anam_avatar_model: str = "cara-4"
    # ← MUST be filled before anam_enabled can be True. There is deliberately no
    # default: an avatar with the wrong voice is worse than no avatar, so an
    # empty value refuses (see main.py's lifespan guard) rather than papering
    # over it. The value to set is "Victoria - Refined Coordinator",
    # c48e258f-5050-11f1-9076-5e955d484d11 — the voice the Ria-rithm persona
    # was built with. Unlike the avatar, stock voices are NOT org-owned
    # (createdByOrganizationId: null), so a voice id survives a move between
    # accounts. Recover it with:
    #   curl -s "https://api.anam.ai/v1/voices?perPage=100&search=Victoria" \
    #     -H "Authorization: Bearer $ANAM_API_KEY" | jq '.data[] | {id, name}'
    anam_voice_id: str = ""
    anam_persona_name: str = "Rithm"

    # WHICH BRAIN ANSWERS ON THE VOICE SURFACE. This was CUSTOMER_CLIENT_V1 —
    # Anam's "Disable LLM", which left it as ears and mouth only while
    # agent.py did the interviewing. It is now Anam's own GPT OSS 120B
    # (openai/gpt-oss-120b, via Groq), attached to the Ria-rithm persona.
    #
    # The reason is latency and nothing else. The old path was two SEQUENTIAL
    # Bedrock calls — nova-micro extraction, then Claude Haiku — with the FULL
    # reply generated before the avatar spoke a single word. Anam streams its
    # own model straight into its own TTS, so the first word lands in a
    # fraction of the time.
    #
    # WHAT THIS COSTS, stated plainly because it is not recoverable from the
    # code: the interview prompt now lives in the Anam Lab console rather than
    # in git, so it is unreviewed and changeable by anyone with dashboard
    # access; and the closed genre/mood vocabularies are no longer guaranteed
    # in CONVERSATION. They are still enforced on the way into the draft —
    # conversation/api.py's record path runs agent.py's extractor over every
    # user turn — so the RECORD stays correct even when the talk wanders.
    #
    # Setting this back to CUSTOMER_CLIENT_V1 without restoring the client-side
    # reply path leaves NOBODY answering and a mute avatar. main.py refuses to
    # boot on exactly that, which is the old guard turned around.
    anam_llm_id: str = "a7cf662c-2ace-4de1-a21e-ef0fbf144bb7"

    # The value that used to live in anam_llm_id, kept as a named constant
    # because the boot guard and the tests both need to say it.
    anam_disabled_llm_id: str = "CUSTOMER_CLIENT_V1"

    # The FREE tier's shape, as settings rather than as magic numbers. The SPA's
    # countdown runs off what the API returns, so changing the plan is a
    # task-definition edit and not a frontend release.
    anam_session_seconds: int = 180
    # The lease is ADVISORY toward Anam (conversation/lease.py), so its TTL must
    # exceed the session cap — a client that overruns must still be holding a
    # lease when it does.
    anam_lease_slack_seconds: int = 15
    # A cap on session STARTS, not turns. Stops one user churning start/stop
    # through a 30-minute monthly budget.
    anam_max_sessions_per_user_per_day: int = 10

    # One outbound call, no retry. Deliberately well under the SPA's patience: a
    # slow mint should fail to the Lottie, not hang on a black box. A retry here
    # would also be actively wrong — the failure this call actually has is
    # CAPACITY, which retrying makes worse.
    anam_token_timeout_seconds: float = 8.0

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

    @property
    def chat_model_ids(self) -> tuple[str, ...]:
        """`bedrock_chat_model_ids` as an ordered tuple, blanks dropped."""
        return tuple(
            part.strip()
            for part in self.bedrock_chat_model_ids.split(",")
            if part.strip()
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
