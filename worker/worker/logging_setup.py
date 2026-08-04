"""
Structured logging, matching api/app/shared/logging.py.

Both trees emit the same JSON shape into CloudWatch, so one Logs Insights query
can follow a job across the API→SQS→worker→SNS→API hop by job_id.

Note the absence of structlog.stdlib.add_logger_name: it reads logger.name,
which PrintLogger does not have. Adding it crashes on the first log call — the
same deviation recorded for the API in docs/InitialSetup/specDeviations.md.
"""

import logging

import structlog
from structlog.typing import EventDict, WrappedLogger

_SENSITIVE_KEYS = frozenset(
    {
        "password",
        "api_key",
        "authorization",
        "access_key",
        "secret_key",
        "db_generation_dsn_sync",
    }
)


def _scrub_sensitive(
    _logger: WrappedLogger, _method: str, event_dict: EventDict
) -> EventDict:
    for key in list(event_dict.keys()):
        if key.lower() in _SENSITIVE_KEYS:
            event_dict[key] = "**REDACTED**"
    return event_dict


def configure_logging(log_level: str = "INFO") -> None:
    level = getattr(logging, log_level.upper(), logging.INFO)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.format_exc_info,
            _scrub_sensitive,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
