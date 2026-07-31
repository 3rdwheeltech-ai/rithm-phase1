"""
HMAC-signed, self-contained SSE tokens.

EventSource cannot send an Authorization header, so the stream URL carries a
short-lived signed token instead. No JWT library needed — this is one claim set
and one signature.
"""
import base64
import hashlib
import hmac
import json
import time
from typing import Any


class SSETokenError(Exception):
    """Raised for a malformed, tampered, or expired SSE token."""


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(encoded: str) -> bytes:
    return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))


def _sign(body: str, key: str) -> str:
    return _b64(
        hmac.new(key.encode(), body.encode(), hashlib.sha256).digest()
    )


def mint(user_id: str, job_id: str, key: str, ttl_seconds: int) -> str:
    payload = {
        "uid": user_id,
        "jid": job_id,
        "exp": int(time.time()) + ttl_seconds,
    }
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{_sign(body, key)}"


def verify(token: str, key: str) -> dict[str, Any]:
    try:
        body, separator, signature = token.partition(".")
        if not separator:
            raise SSETokenError("malformed token")
        if not hmac.compare_digest(signature, _sign(body, key)):
            raise SSETokenError("bad signature")
        payload: dict[str, Any] = json.loads(_unb64(body))
    except SSETokenError:
        raise
    except Exception as exc:
        raise SSETokenError("malformed token") from exc

    if int(payload.get("exp", 0)) < time.time():
        raise SSETokenError("expired")
    return payload
