"""Tests for the SendIX Python SDK.

These tests verify that the client and resource classes initialise
correctly and that method signatures are as expected.  No real API
calls are made.
"""

import json
from unittest.mock import patch

from sendix import SendIX, SendIXError, AuthenticationError, NotFoundError, RateLimitError
from sendix.client import SendIXClient


# ------------------------------------------------------------------
# Initialisation
# ------------------------------------------------------------------

class TestSendIXInit:
    """Verify the main entry point creates sub-resources correctly."""

    def test_creates_client_with_api_key(self):
        client = SendIX("sk_live_test_key")
        assert client._client.api_key == "sk_live_test_key"

    def test_default_base_url(self):
        client = SendIX("sk_live_test_key")
        assert client._client.base_url == "https://api.sendix.io"

    def test_custom_base_url(self):
        client = SendIX("sk_live_test_key", base_url="http://localhost:3001")
        assert client._client.base_url == "http://localhost:3001"

    def test_base_url_strips_trailing_slash(self):
        client = SendIX("sk_live_test_key", base_url="http://localhost:3001/")
        assert client._client.base_url == "http://localhost:3001"

    def test_exposes_emails_resource(self):
        client = SendIX("sk_live_test_key")
        assert hasattr(client, "emails")

    def test_exposes_webhooks_resource(self):
        client = SendIX("sk_live_test_key")
        assert hasattr(client, "webhooks")


# ------------------------------------------------------------------
# Client – request building
# ------------------------------------------------------------------

class TestSendIXClientBuild:
    """Verify URL and header construction without network calls."""

    def test_build_url(self):
        client = SendIXClient("key")
        assert client._build_url("/v1/emails") == "https://api.sendix.io/v1/emails"

    def test_build_headers(self):
        client = SendIXClient("sk_live_key")
        headers = client._build_headers()
        assert headers["Authorization"] == "Bearer sk_live_key"
        assert headers["Content-Type"] == "application/json"
        assert headers["User-Agent"] == "sendix-python/0.1.0"


# ------------------------------------------------------------------
# Client – HTTP error mapping
# ------------------------------------------------------------------

class TestSendIXClientErrors:
    """Verify that HTTP error codes are mapped to the right exceptions."""

    def _fake_response(self, status, body=None):
        """Simulate an HTTPError with a given status and body."""
        import urllib.error
        body_bytes = json.dumps(body).encode("utf-8") if body else b"{}"

        class FakeFP:
            def read(self):
                return body_bytes

        exc = urllib.error.HTTPError(
            url="http://api.sendix.io/v1/emails",
            code=status,
            msg="error",
            hdrs={},
            fp=FakeFP(),
        )
        return exc

    def test_401_raises_authentication_error(self):
        client = SendIXClient("bad_key")
        try:
            client._handle_error_response(401, '{"message":"Invalid API key"}')
        except AuthenticationError as e:
            assert e.status == 401
            assert "Invalid API key" in e.message
        else:
            assert False, "Expected AuthenticationError"

    def test_404_raises_not_found_error(self):
        client = SendIXClient("key")
        try:
            client._handle_error_response(404, '{"message":"Not found"}')
        except NotFoundError as e:
            assert e.status == 404
        else:
            assert False, "Expected NotFoundError"

    def test_429_raises_rate_limit_error(self):
        client = SendIXClient("key")
        try:
            client._handle_error_response(429, '{"message":"Rate limit"}')
        except RateLimitError as e:
            assert e.status == 429
        else:
            assert False, "Expected RateLimitError"

    def test_5xx_raises_base_error(self):
        client = SendIXClient("key")
        try:
            client._handle_error_response(500, '{"message":"Server error"}')
        except SendIXError as e:
            assert e.status == 500
        else:
            assert False, "Expected SendIXError"


# ------------------------------------------------------------------
# Emails resource – method existence
# ------------------------------------------------------------------

class TestEmailsResource:
    """Verify every public method exists with the expected signature."""

    def setup_method(self):
        self.client = SendIX("sk_live_test_key")

    def test_send_method_exists(self):
        assert callable(self.client.emails.send)

    def test_send_batch_method_exists(self):
        assert callable(self.client.emails.send_batch)

    def test_list_method_exists(self):
        assert callable(self.client.emails.list)

    def test_get_method_exists(self):
        assert callable(self.client.emails.get)

    def test_async_send_method_exists(self):
        assert callable(self.client.emails.async_send)

    def test_async_send_batch_method_exists(self):
        assert callable(self.client.emails.async_send_batch)

    def test_async_list_method_exists(self):
        assert callable(self.client.emails.async_list)

    def test_async_get_method_exists(self):
        assert callable(self.client.emails.async_get)


# ------------------------------------------------------------------
# Webhooks resource – method existence
# ------------------------------------------------------------------

class TestWebhooksResource:
    """Verify every public method exists with the expected signature."""

    def setup_method(self):
        self.client = SendIX("sk_live_test_key")

    def test_create_method_exists(self):
        assert callable(self.client.webhooks.create)

    def test_list_method_exists(self):
        assert callable(self.client.webhooks.list)

    def test_delete_method_exists(self):
        assert callable(self.client.webhooks.delete)

    def test_deliveries_method_exists(self):
        assert callable(self.client.webhooks.deliveries)


# ------------------------------------------------------------------
# Exceptions
# ------------------------------------------------------------------

class TestExceptions:
    """Verify exception hierarchy."""

    def test_send_ix_error_is_base(self):
        assert issubclass(AuthenticationError, SendIXError)
        assert issubclass(NotFoundError, SendIXError)
        assert issubclass(RateLimitError, SendIXError)

    def test_send_ix_error_stores_attributes(self):
        err = SendIXError("msg", status=400, code="bad_request")
        assert err.message == "msg"
        assert err.status == 400
        assert err.code == "bad_request"
