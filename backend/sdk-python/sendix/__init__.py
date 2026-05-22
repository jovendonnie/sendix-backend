"""SendIX — Official Python SDK for the SendIX email platform."""

from .client import SendIXClient
from .exceptions import (
    AuthenticationError,
    NotFoundError,
    RateLimitError,
    SendIXError,
    ValidationError,
)
from .resources.emails import Emails
from .resources.webhooks import Webhooks


class SendIX:
    """Main entry point for the SendIX SDK.

    Usage::

        from sendix import SendIX

        client = SendIX("sk_live_your_api_key")
        result = client.emails.send({
            "to": "user@example.com",
            "subject": "Hello",
            "html": "<p>Hello world</p>",
        })

    Args:
        api_key: Your SendIX API key.
        base_url: Base URL of the SendIX API (defaults to production).
    """

    def __init__(self, api_key: str, base_url: str = "https://api.sendix.io"):
        self._client = SendIXClient(api_key, base_url)
        self.emails = Emails(self._client)
        self.webhooks = Webhooks(self._client)


__all__ = [
    "SendIX",
    "SendIXError",
    "AuthenticationError",
    "ValidationError",
    "NotFoundError",
    "RateLimitError",
]
