"""
Liveness and diagnostic health endpoints.

/health      — what the ALB target group and the container HEALTHCHECK hit.
               Performs NO I/O. If it touched the DB, an RDS blip would cycle
               every ECS task.
/health/deep — manual diagnostic. Pings one session per module. Never wire
               this to a healthcheck.
"""

import structlog
from fastapi import APIRouter, Response
from sqlalchemy import text

from app.config import API_VERSION
from app.shared.db import MODULE_NAMES, get_session

logger = structlog.get_logger()

router = APIRouter(tags=["ops"])


@router.get("/health", include_in_schema=False)
async def health() -> dict[str, str]:
    """Liveness only — no I/O of any kind. See the module docstring."""
    return {"status": "ok", "version": API_VERSION}


@router.get("/health/deep", include_in_schema=False)
async def health_deep(response: Response) -> dict[str, object]:
    """
    Per-module `SELECT 1`. Returns 503 if any module fails.

    `SELECT 1` needs no table grant, so it works under the DML-only module
    roles (ops/db/00_init.sql grants USAGE ON SCHEMA, not table privileges).
    """
    results: dict[str, str] = {}
    ok = True

    for module in MODULE_NAMES:
        try:
            async with get_session(module) as session:
                await session.execute(text("SELECT 1"))
            results[module] = "ok"
        except Exception as exc:  # noqa: BLE001 — diagnostic: report, never raise
            results[module] = "error"
            ok = False
            logger.warning("health_deep_module_failed", module=module, error=str(exc))

    if not ok:
        response.status_code = 503
    return {"db": "ok" if ok else "error", "modules": results}
