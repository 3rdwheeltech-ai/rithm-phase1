"""
The Anam vendor boundary: one call, one token, no leakage.

Anam is a FACE AND A VOICE, and nothing else. It supplies speech-to-text,
text-to-speech and the avatar rendering; `agent.py` remains the brain. That
separation is not a preference — it is what makes the fallback lossless, and it
is enforced by `personaConfig.llmId = "CUSTOMER_CLIENT_V1"` below.

Placement mirrors `agent.py`'s rule: the persona configuration is product copy
about this module's domain, so it lives in the module rather than in
`app/shared/`. import-linter's independence contract also means a separate
module could reach neither conversation's settings nor its service.

This file imports only app.config, httpx, structlog, pydantic and
app.shared.exceptions.
"""

import httpx
import structlog
from pydantic import BaseModel, Field, ValidationError

from app.config import get_settings
from app.shared.exceptions import (
    VoiceAtCapacityException,
    VoiceUnavailableException,
)

logger = structlog.get_logger()

# How long the SPA is told to wait when Anam itself says "at capacity". The
# lease (lease.py) supplies a REAL number whenever we know one; this is only
# reached when Anam refuses a mint we thought we had a slot for, which means
# some other holder of this API key is talking.
_VENDOR_CAPACITY_RETRY_SECONDS = 60


class _TokenResponse(BaseModel):
    """
    Anam's answer, parsed rather than subscripted.

    Straight through a model for the reason `agent.py:340` records: a
    `response.json()` is `Any`, and under pyright strict every downstream touch
    of an Any is a fresh error against a baseline that has no room in it.

    `min_length=1` is what turns "2xx with an empty sessionToken" into a
    ValidationError, i.e. into a refusal, rather than into a client that
    connects with an empty credential and fails somewhere far less legible.
    """

    session_token: str = Field(alias="sessionToken", min_length=1)


async def mint_session_token() -> str:
    """
    One short-lived Anam session token. Raises rather than returning None.

    ONE OUTBOUND CALL, NO RETRY, no shared helper, no tenacity. There is no
    outbound-HTTP utility in this codebase and this is not the change that
    writes one — and a retry here would be actively wrong, because the failure
    this call actually has is CAPACITY, which retrying makes worse.
    """
    settings = get_settings()

    body = {
        # personaConfig, NOT personaId, for two reasons.
        #
        # First, CUSTOMER_CLIENT_V1 *is* the brain setting, and a saved persona
        # carries its own llmId — referencing a persona id would hand us the
        # vendor's Gemini back, silently.
        #
        # That is CONFIRMED against the live API, not inferred from the docs:
        #   - personaConfig is a oneOf. It is EITHER this object OR
        #     {"personaId": "…"}, never both — so there is no way to name a
        #     saved persona AND still pin llmId here. Passing a persona id is
        #     choosing whatever brain that persona happens to be saved with.
        #   - GET /v1/llms lists CUSTOMER_CLIENT_V1 with displayName
        #     "Disable LLM" and llmFormat "none". It is the vendor's own off
        #     switch, which is why it is a magic string and not a UUID.
        #   - The Ria-rithm persona in the Lab (dc179739-…) answers with
        #     llmId a7cf662c-… = GPT OSS 120B, a LIVE brain, and carries the
        #     whole of docs/others/anam-system.md in brain.systemPrompt plus a
        #     Knowledge tool. Referencing it by id would hand the interview to
        #     that model and produce exactly the silent failure above. It is
        #     inert only because this body sends personaConfig instead — and
        #     that model WAS tried as the brain, briefly, and reverted: it
        #     rambled, and it cannot see the draft.
        # So "use the persona I made in the Lab" is not a config change here:
        # it is copying that persona's avatarId and voiceId into config.py,
        # which is what anam_avatar_id and anam_voice_id already hold.
        #
        # Second, it puts the avatar, the voice and the model in config.py
        # under review, rather than in whatever state someone last left the
        # Anam Lab UI in. A saved persona's brain is set in a web console: not
        # in git, not reviewed, changeable by anyone with dashboard access.
        #
        # No systemPrompt is sent. Anam accepts one, and with CUSTOMER_CLIENT_V1
        # it could only shape idle expression and delivery — it is not on the
        # path that answers anything. Sending one anyway is a trap: the next
        # reader sees a prompt in personaConfig, assumes that is where the
        # assistant's character lives, and edits it. Then there are two prompts
        # that each think they run the interview. Director Notes
        # (`directorNotes`) are the field for delivery, and carry no such
        # ambiguity.
        "personaConfig": {
            "name": settings.anam_persona_name,
            "avatarId": settings.anam_avatar_id,
            "avatarModel": settings.anam_avatar_model,
            "voiceId": settings.anam_voice_id,
            "llmId": settings.anam_llm_id,
        }
    }

    try:
        # A per-request client and a flat timeout, in the idiom of the only
        # other outbound HTTP in this API (generation/api.py's SNS confirm).
        async with httpx.AsyncClient(
            timeout=settings.anam_token_timeout_seconds
        ) as client:
            response = await client.post(
                f"{settings.anam_api_base}/auth/session-token",
                headers={
                    "Authorization": (
                        f"Bearer {settings.anam_api_key.get_secret_value()}"
                    )
                },
                json=body,
            )
    except httpx.HTTPError as exc:
        # Type name only. A transport error's string can carry the URL, and the
        # URL is not interesting enough to risk a habit of logging exception
        # text on a path that handles a credential.
        logger.info("anam_token_minted", ok=False, error=type(exc).__name__)
        raise VoiceUnavailableException() from exc

    # Status and a flag. Never the token, never the key, never the body.
    logger.info(
        "anam_token_minted", ok=response.is_success, status=response.status_code
    )

    if response.status_code == 429:
        raise VoiceAtCapacityException(
            retry_after_seconds=_VENDOR_CAPACITY_RETRY_SECONDS
        )
    if not response.is_success:
        raise VoiceUnavailableException()

    try:
        parsed = _TokenResponse.model_validate_json(response.content)
    except ValidationError as exc:
        # A 2xx that carries no usable token is a refusal, not a success.
        raise VoiceUnavailableException() from exc

    return parsed.session_token
