"""
Cognito JWT validation + local user resolution.

Validates Cognito RS256 id_tokens via JWKS (keys cached in-process).
`require_claims` — parses and verifies the Bearer token.
`require_user`   — resolves cognito_sub → local `identity.users.id` (lazy-creates row if
                   this is the user's first request after signup).
"""
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, Request, status
from jwt import PyJWKClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid_utils import uuid7

from app.config import get_settings
from app.shared.db import get_identity_db

_settings = get_settings()

_ISSUER = (
    f"https://cognito-idp.{_settings.aws_region}.amazonaws.com/"
    f"{_settings.cognito_user_pool_id}"
)

# PyJWKClient fetches and caches the public keys from Cognito's JWKS endpoint.
_jwk_client = PyJWKClient(
    f"{_ISSUER}/.well-known/jwks.json",
    cache_keys=True,
)


def _decode(token: str) -> dict:
    signing_key = _jwk_client.get_signing_key_from_jwt(token).key
    return jwt.decode(
        token,
        signing_key,
        algorithms=["RS256"],
        audience=_settings.cognito_app_client_id,
        issuer=_ISSUER,
        options={"require": ["exp", "iss", "sub"]},
    )


async def require_claims(request: Request) -> dict:
    """Extract and verify the Bearer id_token. Returns the decoded claims dict."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    try:
        claims = _decode(auth.split(" ", 1)[1])
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    # We only accept id_tokens (not access tokens) as the bearer credential.
    if claims.get("token_use") != "id":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong token type — id_token required")
    return claims


async def require_user(
    claims: dict = Depends(require_claims),
    db: AsyncSession = Depends(get_identity_db),
) -> UUID:
    """
    Resolve cognito_sub → local user_id (UUID).
    Creates the identity.users row lazily on the user's first authenticated request
    (ON CONFLICT DO NOTHING handles any race between signup and first login).
    """
    sub: str = claims["sub"]

    row = (
        await db.execute(
            text("SELECT id FROM identity.users WHERE cognito_sub = :sub"),
            {"sub": sub},
        )
    ).first()

    if row:
        return row[0]

    # Lazy creation — signup endpoint also inserts, so ON CONFLICT is the safety net.
    # flush() (not commit()) — get_identity_db owns the transaction and commits on exit.
    await db.execute(
        text("""
            INSERT INTO identity.users (id, cognito_sub, email)
            VALUES (:id, :sub, :email)
            ON CONFLICT (cognito_sub) DO NOTHING
        """),
        {"id": str(uuid7()), "sub": sub, "email": claims.get("email", "")},
    )
    await db.flush()

    row = (
        await db.execute(
            text("SELECT id FROM identity.users WHERE cognito_sub = :sub"),
            {"sub": sub},
        )
    ).first()

    return row[0]
