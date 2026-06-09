from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    consent_version: str
    # Required attributes on the dev user pool (immutable pool config).
    # given_name is derived from name server-side.
    name: str = Field(min_length=1, max_length=128)
    phone_number: str = Field(pattern=r"^\+[1-9]\d{1,14}$")  # E.164


class SignupResponse(BaseModel):
    user_id: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    # email is required to compute the Cognito SECRET_HASH for REFRESH_TOKEN_AUTH
    # (the app client has a secret) — see specDeviations.md.
    email: EmailStr
    refresh_token: str


class TokenResponse(BaseModel):
    id_token: str
    refresh_token: str | None = None
    expires_in: int
    token_type: str


class MeResponse(BaseModel):
    user_id: str
    email: str
    is_admin: bool
