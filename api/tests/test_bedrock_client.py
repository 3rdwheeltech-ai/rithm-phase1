"""
The Bedrock client's endpoint, which is the one thing about it that is easy to
get wrong and impossible to notice.

`converse` itself is exercised through the fakes in test_authoring.py — what
cannot be faked is which host boto3 decided to talk to, and that is settled at
client-construction time by configuration rather than by any code path a test
can drive. Hence a test that builds the real client and reads the endpoint back
off it, without ever sending a request.
"""

# _bedrock_client is private and probed directly: the endpoint it resolves is
# the assertion, and there is no public surface that exposes one.
# pyright: reportPrivateUsage=false
import pytest

from app.config import get_settings
from app.shared import aws


@pytest.fixture(autouse=True)
def fresh_clients() -> None:
    """The client is cached for the process; these tests each need a new one."""
    get_settings.cache_clear()
    aws.reset_clients()


def test_the_bedrock_client_ignores_a_configured_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    LocalStack has no Bedrock, and docker-compose sets AWS_ENDPOINT_URL for
    every other service in the stack.

    Omitting `endpoint_url=` is NOT what protects this. AWS_ENDPOINT_URL is a
    botocore-NATIVE environment variable applied to every service
    automatically, so without `ignore_configured_endpoint_urls` the client
    silently resolves to localstack:4566 and every Converse comes back as
    LocalStack's "unknown operation for service bedrock" — which looks like a
    Bedrock outage, degrades to the fallback, and is therefore invisible.
    """
    monkeypatch.setenv("AWS_ENDPOINT_URL", "http://localstack:4566")
    monkeypatch.setenv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "http://localstack:4566")
    get_settings.cache_clear()

    endpoint = str(aws._bedrock_client().meta.endpoint_url)

    assert endpoint == "https://bedrock-runtime.us-east-1.amazonaws.com"
    assert "localstack" not in endpoint


def test_the_sqs_client_still_honours_the_configured_endpoint() -> None:
    """
    The flag above is scoped to Bedrock and must not leak: LocalStack IS where
    SQS and S3 are meant to go locally, and a client that ignored the override
    would send the whole dev stack at real AWS.
    """
    settings = get_settings()
    if not settings.aws_endpoint_url:
        pytest.skip("no endpoint override configured in this environment")

    assert settings.aws_endpoint_url in str(aws._sqs().meta.endpoint_url)


def test_one_attempt_and_short_timeouts() -> None:
    """
    The caller already has an asyncio timeout and a fallback. botocore's
    default three retries would blow through both, and a retry storm — not the
    price per call — is the cost worth watching on this feature.

    Asserted on the NORMALISED key, because that is where the trap is:
    botocore reads `max_attempts` as a retry count and turns `max_attempts=1`
    into `total_max_attempts=2`. One really does have to mean one — the title
    call's entire budget is 4s and a second 10s read could never land inside
    it.
    """
    config = aws._bedrock_client().meta.config

    assert config.retries["total_max_attempts"] == 1
    assert config.connect_timeout == 2
    assert config.read_timeout == 10
