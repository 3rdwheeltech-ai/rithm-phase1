from uuid import UUID

from botocore.exceptions import ClientError
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.modules.identity.schemas import (
    LoginRequest,
    MeResponse,
    Profile,
    ProfilePatchRequest,
    RefreshRequest,
    SignupRequest,
    SignupResponse,
    TokenResponse,
)
from app.modules.identity.service import identity_service
from app.shared.auth import require_user
from app.shared.db import get_identity_db

router = APIRouter(tags=["identity"])
_settings = get_settings()

# Map Cognito error codes to HTTP status codes.
_COGNITO_HTTP: dict[str, int] = {
    "UsernameExistsException": status.HTTP_409_CONFLICT,
    "InvalidPasswordException": status.HTTP_400_BAD_REQUEST,
    "InvalidParameterException": status.HTTP_400_BAD_REQUEST,
    "NotAuthorizedException": status.HTTP_401_UNAUTHORIZED,
    "UserNotFoundException": status.HTTP_401_UNAUTHORIZED,
    "UserNotConfirmedException": status.HTTP_403_FORBIDDEN,
}


def _http(err: ClientError) -> HTTPException:
    code = err.response["Error"]["Code"]
    msg = err.response["Error"].get("Message", code)
    return HTTPException(_COGNITO_HTTP.get(code, status.HTTP_400_BAD_REQUEST), msg)


@router.post("/auth/signup", response_model=SignupResponse, status_code=201)
async def signup(
    body: SignupRequest,
    db: AsyncSession = Depends(get_identity_db),
) -> SignupResponse:
    if body.consent_version != _settings.current_consent_version:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Stale consent version '{body.consent_version}'. "
            f"Expected '{_settings.current_consent_version}'. "
            "Reload the page and retry.",
        )
    try:
        user_id = await identity_service.signup(
            db, body.email, body.password, body.name, body.phone_number
        )
    except ClientError as exc:
        raise _http(exc) from exc
    return SignupResponse(user_id=user_id)


@router.post("/auth/login", response_model=TokenResponse)
async def login(body: LoginRequest) -> TokenResponse:
    try:
        result = await identity_service.login(body.email, body.password)
    except ClientError as exc:
        raise _http(exc) from exc
    return TokenResponse(
        id_token=result["IdToken"],
        refresh_token=result["RefreshToken"],
        expires_in=result["ExpiresIn"],
        token_type=result["TokenType"],
    )


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest,
    db: AsyncSession = Depends(get_identity_db),
) -> TokenResponse:
    # SECRET_HASH for REFRESH_TOKEN_AUTH must use the user's actual Cognito
    # username (the sub), not the email alias — resolve it from identity.users.
    row = (
        await db.execute(
            text("SELECT cognito_sub FROM identity.users WHERE email = :email"),
            {"email": body.email},
        )
    ).first()
    if not row:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unknown user")
    try:
        result = await identity_service.refresh(body.refresh_token, row[0])
    except ClientError as exc:
        raise _http(exc) from exc
    return TokenResponse(
        id_token=result["IdToken"],
        refresh_token=None,  # Cognito does not rotate the refresh token here
        expires_in=result["ExpiresIn"],
        token_type=result["TokenType"],
    )


@router.get("/me", response_model=MeResponse)
async def me(
    user_id: UUID = Depends(require_user),
    db: AsyncSession = Depends(get_identity_db),
) -> MeResponse:
    """
    Identity plus the profile document, in one round trip.

    The SPA blocks its authed shell on this call (the onboarding gate reads
    `profile.onboarding`), so it deliberately carries everything the chrome and
    the Settings page need rather than making them ask twice.
    """
    response = await identity_service.get_me(db, user_id)
    if response is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return response


@router.patch("/me/profile", response_model=Profile)
async def patch_me_profile(
    body: ProfilePatchRequest,
    user_id: UUID = Depends(require_user),
    db: AsyncSession = Depends(get_identity_db),
) -> Profile:
    """
    Partial update of the profile document.

    Returns the full updated profile rather than 204 so the client can write it
    straight into its cache. That matters: the onboarding gate reads the cached
    document, and a refetch round trip would re-evaluate it against stale data
    and bounce the user back to /onboarding the frame after they finished it.
    """
    profile = await identity_service.patch_profile(db, user_id, body)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return profile
