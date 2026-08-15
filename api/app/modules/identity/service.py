"""
Identity service — backend-mediated Cognito auth.

boto3 Cognito calls are synchronous; `run_in_threadpool` offloads them to a thread pool
so they do not block the async event loop.

Phase 1: `AdminConfirmSignUp` is called immediately after `SignUp` so users can log in
without completing an email verification step.
"""

import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import boto3
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid_utils import uuid7

from app.config import get_settings
from app.modules.identity.models import (
    ME_COLUMNS,
    USERS_TABLE,
    MeRow,
    decode_profile,
    initial_profile,
    normalize_profile,
)
from app.modules.identity.schemas import MeResponse, Profile, ProfilePatchRequest

_settings = get_settings()

# Endpoint pinned to real AWS: the local dev container sets AWS_ENDPOINT_URL to
# LocalStack (for S3/SQS/SNS), but Cognito must always hit the real dev pool —
# LocalStack's Cognito coverage is incomplete.
_cognito = boto3.client(
    "cognito-idp",
    region_name=_settings.aws_region,
    endpoint_url=f"https://cognito-idp.{_settings.aws_region}.amazonaws.com",
)


def _secret_hash(username: str) -> str:
    """
    Cognito SECRET_HASH: Base64(HMAC-SHA256(client_secret, username + client_id)).
    Required on every call because the app client was created with a secret.
    """
    digest = hmac.new(
        _settings.cognito_app_client_secret.get_secret_value().encode(),
        (username + _settings.cognito_app_client_id).encode(),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(digest).decode()


# ── Profile SQL ───────────────────────────────────────────────────────────
# Built once at import. The table name is a module constant, never a caller's
# string, so the f-string is not an injection surface — every value is bound.
_SELECT_ME = text(f"SELECT {ME_COLUMNS} FROM {USERS_TABLE} WHERE id = :id")  # noqa: S608
_SELECT_PROFILE_FOR_UPDATE = text(
    f"SELECT profile FROM {USERS_TABLE} WHERE id = :id FOR UPDATE"  # noqa: S608
)
_UPDATE_PROFILE = text(
    f"UPDATE {USERS_TABLE} SET profile = CAST(:profile AS JSONB) WHERE id = :id"  # noqa: S608
)


def merge_profile(
    current: dict[str, Any],
    patch: ProfilePatchRequest,
    *,
    now: datetime,
) -> dict[str, Any]:
    """
    Apply only the keys the request actually set. Pure — no DB, no clock.

    `model_dump(exclude_unset=True)` is what makes the three cases distinct:
    an absent key leaves the stored value alone, an explicit null clears it, and
    a value replaces it. It recurses into `preferences`, so a patch touching one
    preference produces a one-key dict and the siblings survive untouched.

    That per-key granularity is also why the SQL side is a read-modify-write
    rather than `profile || :patch`: the `||` operator merges only at the top
    level, so patching one preference would drop every other one.
    """
    merged = normalize_profile(current)
    body = patch.model_dump(exclude_unset=True)

    if "display_name" in body:
        merged["display_name"] = body["display_name"] or ""

    if isinstance(body.get("preferences"), dict):
        # Key-by-key, not a wholesale replace — see the docstring.
        merged["preferences"] = {**merged["preferences"], **body["preferences"]}

    action = body.get("onboarding_action")
    if action is not None:
        merged["onboarding"] = {
            **merged["onboarding"],
            # Only stamp the first time. Re-running onboarding (or a retried
            # request) must not move the original completion date.
            "completed_at": merged["onboarding"]["completed_at"]
            or now.isoformat().replace("+00:00", "Z"),
            "skipped": action == "skip",
        }

    # Re-normalize: the patch is already validated, but this re-applies the caps
    # and fills any key a future version added.
    return normalize_profile(merged)


class IdentityService:
    async def signup(
        self,
        db: AsyncSession,
        email: str,
        password: str,
        name: str,
        phone_number: str,
    ) -> str:
        """
        Register a new user in Cognito and create the local identity.users row.
        Returns the new local user_id as a string.

        name/given_name/phone_number are required attributes on the dev user
        pool; given_name mirrors name. Cognito remains their system of record;
        the local row additionally seeds `profile.display_name` from name,
        because this is the one moment the API knows it — the lazy insert in
        shared/auth.py only ever sees the token claims.
        """
        resp = await run_in_threadpool(
            _cognito.sign_up,
            ClientId=_settings.cognito_app_client_id,
            SecretHash=_secret_hash(email),
            Username=email,
            Password=password,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "name", "Value": name},
                {"Name": "given_name", "Value": name},
                {"Name": "phone_number", "Value": phone_number},
            ],
        )
        sub: str = resp["UserSub"]

        # Phase 1: bypass email verification — confirm the user immediately.
        # AdminSetUserPassword with Permanent=True moves an UNCONFIRMED user to
        # CONFIRMED (same effect as AdminConfirmSignUp, which the scoped dev IAM
        # user is not granted). Password is unchanged — we set the same one.
        await run_in_threadpool(
            _cognito.admin_set_user_password,
            UserPoolId=_settings.cognito_user_pool_id,
            Username=email,
            Password=password,
            Permanent=True,
        )

        user_id = str(uuid7())
        # No explicit commit — the get_identity_db dependency commits on success.
        await db.execute(
            text("""
                INSERT INTO identity.users
                    (id, cognito_sub, email, consent_accepted_at, consent_version,
                     profile)
                VALUES (:id, :sub, :email, now(), :cv, CAST(:profile AS JSONB))
                ON CONFLICT (cognito_sub) DO NOTHING
            """),
            {
                "id": user_id,
                "sub": sub,
                "email": email,
                "cv": _settings.current_consent_version,
                # json.dumps + CAST, never a bare dict: with text() SQLAlchemy
                # has no column type to attach its JSONB codec to, so a dict
                # reaches asyncpg as an unencodable object. Same pattern as
                # catalog/service.py.
                "profile": json.dumps(initial_profile(name)),
            },
        )
        return user_id

    async def get_me(self, db: AsyncSession, user_id: UUID) -> MeResponse | None:
        """The /me projection, with the profile normalized. None if no such row."""
        row = (await db.execute(_SELECT_ME, {"id": str(user_id)})).mappings().first()
        if row is None:
            return None
        me = MeRow.from_row(row)
        return MeResponse(
            user_id=str(user_id),
            email=me.email,
            is_admin=me.is_admin,
            profile=Profile.model_validate(normalize_profile(me.profile)),
        )

    async def patch_profile(
        self, db: AsyncSession, user_id: UUID, patch: ProfilePatchRequest
    ) -> Profile | None:
        """
        Read-modify-write the profile document. None if no such row.

        `FOR UPDATE` serializes two concurrent PATCHes (two tabs, or Settings
        racing the onboarding submit) for the microseconds until
        get_identity_db commits. Because the merge is per-key, the loser only
        loses the keys it actually set.
        """
        row = (
            await db.execute(_SELECT_PROFILE_FOR_UPDATE, {"id": str(user_id)})
        ).first()
        if row is None:
            return None

        current = decode_profile(row[0])
        merged = merge_profile(current, patch, now=datetime.now(tz=UTC))

        # Skip the write when nothing moved: the users_touch trigger fires on
        # any UPDATE, and a no-op Save should not bump updated_at.
        if merged != current:
            await db.execute(
                _UPDATE_PROFILE,
                {"id": str(user_id), "profile": json.dumps(merged)},
            )
        return Profile.model_validate(merged)

    async def login(self, email: str, password: str) -> dict:
        """Authenticate via USER_PASSWORD_AUTH.

        Returns the raw AuthenticationResult dict.
        """
        resp = await run_in_threadpool(
            _cognito.initiate_auth,
            ClientId=_settings.cognito_app_client_id,
            AuthFlow="USER_PASSWORD_AUTH",
            AuthParameters={
                "USERNAME": email,
                "PASSWORD": password,
                "SECRET_HASH": _secret_hash(email),
            },
        )
        return resp["AuthenticationResult"]

    async def refresh(self, refresh_token: str, username: str) -> dict:
        """
        Exchange a refresh token for a new id_token. Returns AuthenticationResult dict.

        `username` is needed only to compute SECRET_HASH — for REFRESH_TOKEN_AUTH
        Cognito expects the hash computed with the user's actual username
        (the cognito_sub for this pool), not the email alias.
        """
        resp = await run_in_threadpool(
            _cognito.initiate_auth,
            ClientId=_settings.cognito_app_client_id,
            AuthFlow="REFRESH_TOKEN_AUTH",
            AuthParameters={
                "REFRESH_TOKEN": refresh_token,
                "SECRET_HASH": _secret_hash(username),
            },
        )
        return resp["AuthenticationResult"]


# Module-level singleton — boto3 client is thread-safe and reused across requests.
identity_service = IdentityService()
