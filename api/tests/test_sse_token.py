import pytest

from app.modules.generation.sse_token import SSETokenError, mint, verify

_KEY = "test-signing-key"
_UID = "00000000-0000-7000-8000-000000000001"
_JID = "01920000-0000-7000-8000-00000000abcd"


def test_mint_verify_round_trip() -> None:
    payload = verify(mint(_UID, _JID, _KEY, 300), _KEY)
    assert payload["uid"] == _UID
    assert payload["jid"] == _JID
    assert payload["exp"] > 0


def test_tampered_body_rejected() -> None:
    body, _, signature = mint(_UID, _JID, _KEY, 300).partition(".")
    # Flip one character of the payload; the signature no longer covers it.
    tampered = ("A" if body[0] != "A" else "B") + body[1:]
    with pytest.raises(SSETokenError):
        verify(f"{tampered}.{signature}", _KEY)


def test_expired_token_rejected() -> None:
    with pytest.raises(SSETokenError):
        verify(mint(_UID, _JID, _KEY, -1), _KEY)


def test_wrong_key_rejected() -> None:
    with pytest.raises(SSETokenError):
        verify(mint(_UID, _JID, _KEY, 300), "a-different-key")


@pytest.mark.parametrize(
    "token", ["", "no-separator", "not-base64.also-not-base64", "."]
)
def test_malformed_token_rejected(token: str) -> None:
    with pytest.raises(SSETokenError):
        verify(token, _KEY)
