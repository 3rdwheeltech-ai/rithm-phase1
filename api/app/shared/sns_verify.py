"""
SNS message signature verification.

For /internal/sns/job-completion the signature check *is* the authentication —
that endpoint carries no auth dependency, so this module is the security
boundary. The SigningCertURL host allowlist is the load-bearing part: without
it an attacker points SigningCertURL at their own host and signs whatever they
like.

Ref: https://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.verify.signature.html
"""

import base64
import re
from typing import Any

import httpx
import structlog
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.hashes import HashAlgorithm
from cryptography.x509 import load_pem_x509_certificate

logger = structlog.get_logger()


class SNSVerificationError(Exception):
    """Raised when an SNS envelope fails signature verification."""


# Allowlist for SigningCertURL — reject anything not served by SNS itself.
_VALID_CERT_URL = re.compile(r"^https://sns\.[a-z0-9\-]+\.amazonaws\.com/")

# Certs rotate rarely; caching avoids an HTTPS round-trip per notification.
_cert_cache: dict[str, bytes] = {}

# Field order and presence differ by message Type (per the SNS spec).
_NOTIFICATION_FIELDS = (
    "Message",
    "MessageId",
    "Subject",
    "Timestamp",
    "TopicArn",
    "Type",
)
_CONFIRMATION_FIELDS = (
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
)


async def _fetch_cert(url: str) -> bytes:
    if not _VALID_CERT_URL.match(url):
        raise SNSVerificationError(f"Suspicious SigningCertURL domain: {url}")
    if url not in _cert_cache:
        # httpx, not urllib.request — a blocking 5s cert fetch would stall the
        # single event loop this process runs on.
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            _cert_cache[url] = response.content
    return _cert_cache[url]


def _build_message_to_sign(payload: dict[str, Any]) -> bytes:
    """Reconstruct the canonical string SNS signed."""
    msg_type = payload.get("Type", "")
    fields = (
        _NOTIFICATION_FIELDS if msg_type == "Notification" else _CONFIRMATION_FIELDS
    )
    parts: list[str] = []
    for field in fields:
        value = payload.get(field)
        if value is not None:
            parts.append(field)
            parts.append(str(value))
    return "\n".join(parts).encode("utf-8") + b"\n"


def _hash_for(signature_version: str) -> HashAlgorithm:
    # SNS SignatureVersion 1 = SHA1, 2 = SHA256. v1 is the default; v2 is
    # opt-in per topic, so both must work.
    if signature_version == "2":
        return hashes.SHA256()
    if signature_version == "1":
        return hashes.SHA1()
    raise SNSVerificationError(f"Unsupported SignatureVersion: {signature_version!r}")


async def verify_sns_signature(payload: dict[str, Any]) -> None:
    """
    Verify an SNS envelope. Raises SNSVerificationError on any failure.

    Must be called before trusting anything from /internal/sns/*.
    """
    cert_url = str(payload.get("SigningCertURL", ""))
    signature_b64 = str(payload.get("Signature", ""))
    signature_version = str(payload.get("SignatureVersion", "1"))

    algorithm = _hash_for(signature_version)

    try:
        cert_pem = await _fetch_cert(cert_url)
        certificate = load_pem_x509_certificate(cert_pem)
        public_key = certificate.public_key()
    except SNSVerificationError:
        raise
    except Exception as exc:
        logger.warning(
            "sns_cert_load_failed",
            event_type="sns.signature.invalid",
            cert_url=cert_url,
            error=str(exc),
        )
        raise SNSVerificationError("Could not load SNS signing cert") from exc

    if not isinstance(public_key, rsa.RSAPublicKey):
        # SNS signs with RSA. Anything else is not a cert we should trust.
        raise SNSVerificationError("SNS signing cert is not an RSA key")

    try:
        public_key.verify(
            base64.b64decode(signature_b64),
            _build_message_to_sign(payload),
            padding.PKCS1v15(),
            algorithm,
        )
    except Exception as exc:
        logger.warning(
            "sns_signature_invalid",
            event_type="sns.signature.invalid",
            cert_url=cert_url,
            error=str(exc),
        )
        raise SNSVerificationError("SNS signature verification failed") from exc
