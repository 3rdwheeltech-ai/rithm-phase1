import logging

import structlog
from structlog.typing import EventDict, WrappedLogger

# Keys whose values must NEVER appear in logs
_SENSITIVE_KEYS = frozenset(
    {
        "password",
        "id_token",
        "refresh_token",
        "api_key",
        "authorization",
        "access_key",
        "secret_key",
        "cognito_sub",
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
            # NOTE: stdlib.add_logger_name is incompatible with PrintLoggerFactory
            # (PrintLogger has no .name) — deviation from spec, crashes
            # startup otherwise.
            structlog.processors.TimeStamper(fmt="iso"),
            # Renders the exc_info=True flag logger.exception() sets into an
            # actual traceback string. Without this, JSONRenderer just
            # serializes the literal boolean and the traceback is lost.
            structlog.processors.format_exc_info,
            _scrub_sensitive,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
