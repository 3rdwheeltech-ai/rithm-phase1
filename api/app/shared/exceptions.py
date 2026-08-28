from typing import Any

from fastapi import HTTPException


class RateLimitExceededException(HTTPException):
    def __init__(self, retry_after_seconds: int, used: int, limit: int) -> None:
        super().__init__(
            status_code=429,
            detail=(
                f"You have used {used} of {limit} generations in the last 24h. "
                f"Try again in {retry_after_seconds} seconds."
            ),
            headers={"Retry-After": str(retry_after_seconds)},
        )
        # Header AND body. The header is the HTTP-correct answer and what a
        # retrying client uses; the body field is what the React toast renders,
        # because reading a response header from JS needs the server to have
        # listed it in Access-Control-Expose-Headers and one missing entry
        # there is a silent undefined rather than an error.
        self.problem_extra: dict[str, Any] = {
            "retry_after_seconds": retry_after_seconds,
            "used": used,
            "limit": limit,
        }


class ResourceNotFoundException(HTTPException):
    def __init__(self, resource: str, resource_id: str) -> None:
        super().__init__(
            status_code=404,
            detail=f"{resource} '{resource_id}' not found or access denied.",
        )


class UpstreamServiceException(HTTPException):
    def __init__(self, service: str, retry_after_seconds: int = 30) -> None:
        super().__init__(
            status_code=502,
            detail=(
                f"Upstream service '{service}' is temporarily unavailable. "
                "Please retry."
            ),
            headers={"Retry-After": str(retry_after_seconds)},
        )


class EnqueueFailedException(HTTPException):
    """
    The job row committed but the queue would not take the message.

    503 rather than UpstreamServiceException's 502: nothing upstream returned a
    bad response — we could not hand the work off at all, and the client should
    retry the identical request. The job has already been marked FAILED by the
    time this is raised, so a retry is a clean new submission.
    """

    def __init__(self, retry_after_seconds: int = 30) -> None:
        super().__init__(
            status_code=503,
            detail=(
                "Your generation could not be scheduled. Please try again in a moment."
            ),
            headers={"Retry-After": str(retry_after_seconds)},
        )


class UnsupportedRefinementException(HTTPException):
    """
    audio_reference refinement is cut for launch (launch-plan §1.2).

    Rejected here AND in the worker's run_inference. Two layers on purpose: the
    edge gives a human-readable error, the worker guarantees it can never
    reach a GPU.
    """

    def __init__(self) -> None:
        super().__init__(
            status_code=400,
            detail=(
                "Audio-reference refinement is not available yet. "
                "Use refinement_mode='fresh'."
            ),
        )


class SSETokenExpiredException(HTTPException):
    """
    The stream token aged out — distinct from every other 401 on purpose.

    A client whose EventSource dies cannot read the response status from the
    EventSource itself, so it probes the URL with a plain fetch and matches on
    this `type`. Matching tells it to stop reconnecting and switch to polling
    GET /jobs/{id}; a generic 401 would instead read as "logged out" and send
    the user to /login mid-generation.

    Only expiry gets this. A malformed token, a bad signature or a token/job
    mismatch stay generic — those are not recoverable by polling.
    """

    problem_type = "https://rithm.dev/errors/sse-token-expired"

    def __init__(self) -> None:
        super().__init__(
            status_code=401,
            detail=(
                "Stream token expired. Re-request the job status to continue "
                "tracking this generation."
            ),
        )


class ConflictException(HTTPException):
    def __init__(self, detail: str) -> None:
        super().__init__(status_code=409, detail=detail)


class ForbiddenException(HTTPException):
    def __init__(self, detail: str = "Insufficient permissions.") -> None:
        super().__init__(status_code=403, detail=detail)


class AssistantUnavailableException(HTTPException):
    """
    No model in the chat chain would answer this turn.

    Its own `type` for the same reason SSETokenExpiredException has one: the
    SPA renders this as a muted inline row inside a chat that is otherwise
    usable, with a retry, rather than as an error toast over the whole page.
    A generic 503 would read as "the app is down".

    The user's message is already committed by the time this is raised. A
    transcript ending on an unanswered user turn is the honest record, and
    rolling it back would silently eat what they typed.
    """

    problem_type = "https://rithm.dev/errors/assistant-unavailable"

    def __init__(self, retry_after_seconds: int = 10) -> None:
        super().__init__(
            status_code=503,
            detail=("The assistant could not answer just now. Try sending that again."),
            headers={"Retry-After": str(retry_after_seconds)},
        )


class ChatSessionFullException(HTTPException):
    """
    409, NOT 429.

    Nothing is rate-limited and waiting will not help — this conversation is
    over its length cap and the fix is to start a new one. Its own type so the
    SPA surfaces the "Start over" control instead of a Retry-After the user
    cannot act on.

    The DAILY cap is a real rate limit and reuses RateLimitExceededException.
    """

    problem_type = "https://rithm.dev/errors/chat-session-full"

    def __init__(self, limit: int) -> None:
        super().__init__(
            status_code=409,
            detail=(
                f"This conversation has reached {limit} messages. "
                "Start a new one to keep going."
            ),
        )
        self.problem_extra: dict[str, Any] = {"limit": limit}


class VoiceAtCapacityException(HTTPException):
    """
    429. The one Anam session is in use — by anyone, anywhere in the product.

    Its own type because the SPA's answer is a COOLDOWN plus a nudge toward
    Chat, not the "you've used all your generations for today" copy that
    ErrorToast renders for the generic 429. On the free tier this is the
    ordinary second-user path, not an incident.

    The free tier's "1 concurrent session" is a property of the API KEY, not of
    a user, so without arbitration the second person in the product to press
    Talk gets a bare 429 from the vendor with no Retry-After anyone can act on.
    `retry_after_seconds` here is computed from the live lease, so it is a real
    number rather than a guess.
    """

    problem_type = "https://rithm.dev/errors/voice-at-capacity"

    def __init__(self, retry_after_seconds: int) -> None:
        super().__init__(
            status_code=429,
            detail="Someone else is talking to the assistant right now.",
            headers={"Retry-After": str(retry_after_seconds)},
        )
        # Header AND body, for the reason RateLimitExceededException records:
        # reading a response header from JS needs the server to have listed it
        # in Access-Control-Expose-Headers, and one missing entry there is a
        # silent undefined rather than an error.
        self.problem_extra: dict[str, Any] = {
            "retry_after_seconds": retry_after_seconds
        }


class VoiceQuotaExceededException(HTTPException):
    """
    429. This user's own daily cap on session STARTS (not turns).

    Distinct from VoiceAtCapacity above: nobody else is talking and waiting a
    minute will not help. The SPA cools Talk down until tomorrow and offers
    Chat, which has its own, much larger, budget.
    """

    problem_type = "https://rithm.dev/errors/voice-quota-exceeded"

    def __init__(self, limit: int, retry_after_seconds: int) -> None:
        super().__init__(
            status_code=429,
            detail=(
                f"You have started {limit} voice sessions in the last 24 hours. "
                "Keep going in chat, or come back tomorrow."
            ),
            headers={"Retry-After": str(retry_after_seconds)},
        )
        self.problem_extra: dict[str, Any] = {
            "retry_after_seconds": retry_after_seconds,
            "limit": limit,
        }


class VoiceUnavailableException(HTTPException):
    """
    503. Configured, but the vendor refused, timed out, or answered nonsense.

    Distinct from the 501 below: this one may work in a minute, that one will
    never work until someone changes a deployment.

    The vendor's own error body is NEVER forwarded. It is a third party's error
    text about a third party's service, and the SPA has exactly one job with
    it: fall back to the Lottie.
    """

    problem_type = "https://rithm.dev/errors/voice-unavailable"

    def __init__(self, retry_after_seconds: int = 30) -> None:
        super().__init__(
            status_code=503,
            detail="Voice could not start just now. You can still chat.",
            headers={"Retry-After": str(retry_after_seconds)},
        )


class VoiceNotConfiguredException(HTTPException):
    """
    501, not 404 and not 403.

    The route exists and the caller did nothing wrong — this deployment simply
    has no Anam key. The SPA reads it as "voice was never here", which is a
    DIFFERENT panel from "voice failed": the first is today's avatar with Talk
    opening Coming Soon, the second names a reason and offers a retry.
    """

    problem_type = "https://rithm.dev/errors/voice-not-configured"

    def __init__(self) -> None:
        super().__init__(
            status_code=501,
            detail="Voice is not available in this environment.",
        )
