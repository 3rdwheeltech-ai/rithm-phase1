import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

# Register on Starlette's base HTTPException (fastapi.HTTPException subclasses it).
# Router-level 404/405s raise the Starlette class directly — a handler registered
# on the FastAPI subclass would never catch them. Deviation from spec.
from starlette.exceptions import HTTPException

logger = structlog.get_logger()


def _problem(
    status: int, title: str, request: Request, detail: object | None = None
) -> dict:
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
        return JSONResponse(
            status_code=exc.status_code,
            content=_problem(exc.status_code, exc.detail, request),
            headers=dict(exc.headers) if exc.headers else {},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=_problem(422, "Validation Error", request, detail=exc.errors()),
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
