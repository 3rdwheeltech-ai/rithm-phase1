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

import boto3
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid_utils import uuid7

from app.config import get_settings

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
        pool; given_name mirrors name. They live in Cognito only — the local
        identity.users table is unchanged.
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
                    (id, cognito_sub, email, consent_accepted_at, consent_version)
                VALUES (:id, :sub, :email, now(), :cv)
                ON CONFLICT (cognito_sub) DO NOTHING
            """),
            {
                "id": user_id,
                "sub": sub,
                "email": email,
                "cv": _settings.current_consent_version,
            },
        )
        return user_id

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
