from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

# Register on Starlette's base HTTPException (fastapi.HTTPException subclasses it).
# Router-level 404/405s raise the Starlette class directly — a handler registered
# on the FastAPI subclass would never catch them. Deviation from spec.
from starlette.exceptions import HTTPException

logger = structlog.get_logger()


def _problem(
    status: int, title: str, request: Request, detail: object | None = None
) -> dict[str, Any]:
    return {
        "type": f"https://rithm.dev/errors/{status}",
        "title": title,
        "status": status,
        "detail": detail,
        "instance": str(request.url.path),
        "request_id": structlog.contextvars.get_contextvars().get("request_id", ""),
    }


def register_error_handlers(app: FastAPI) -> None:

    @app.exception_handler(HTTPException)
    async def http_exception_handler(
        request: Request, exc: HTTPException
    ) -> JSONResponse:
        # The message goes in BOTH fields. `title` is where Day 1 put it and
        # what the existing clients read; `detail` is where RFC 7807 says an
        # occurrence-specific explanation belongs, and leaving it null meant
        # every error this API has ever returned carried a null detail. New
        # clients should read `detail`.
        body = _problem(exc.status_code, exc.detail, request, detail=exc.detail)
        # Typed exceptions may contribute machine-readable fields alongside the
        # prose — e.g. the rate limiter's retry_after_seconds, which the React
        # error toast needs as a number and cannot get from a header it is not
        # allowed to read unless CORS exposes it.
        body.update(getattr(exc, "problem_extra", {}))
        return JSONResponse(
            status_code=exc.status_code,
            content=body,
            headers=dict(exc.headers) if exc.headers else {},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # jsonable_encoder is not optional here: a Pydantic model_validator that
        # raises ValueError puts the raw exception object in the error's `ctx`,
        # and serialising that unencoded turns a 422 into a 500.
        return JSONResponse(
            status_code=422,
            content=_problem(
                422,
                "Validation Error",
                request,
                detail=jsonable_encoder(exc.errors()),
            ),
        )

    @app.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception(
            "unhandled_error",
            event_type="error.5xx",
            error_class=type(exc).__name__,
            error=str(exc),
        )
        return JSONResponse(
            status_code=500,
            content=_problem(500, "Internal Server Error", request),
        )
