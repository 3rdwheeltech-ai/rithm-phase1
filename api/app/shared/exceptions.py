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
                "Your generation could not be scheduled. "
                "Please try again in a moment."
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


class ConflictException(HTTPException):
    def __init__(self, detail: str) -> None:
        super().__init__(status_code=409, detail=detail)


class ForbiddenException(HTTPException):
    def __init__(self, detail: str = "Insufficient permissions.") -> None:
        super().__init__(status_code=403, detail=detail)
