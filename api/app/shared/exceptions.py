from fastapi import HTTPException
from typing import Any


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
            detail=f"Upstream service '{service}' is temporarily unavailable. Please retry.",
            headers={"Retry-After": str(retry_after_seconds)},
        )


class ConflictException(HTTPException):
    def __init__(self, detail: str) -> None:
        super().__init__(status_code=409, detail=detail)


class ForbiddenException(HTTPException):
    def __init__(self, detail: str = "Insufficient permissions.") -> None:
        super().__init__(status_code=403, detail=detail)
