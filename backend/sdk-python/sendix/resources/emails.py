"""Email resource for the SendIX SDK."""

from typing import Optional

from ..client import SendIXClient
from ..types import BatchEmailOptions, ListEmailsOptions, SendEmailOptions


class Emails:
    """Wraps the SendIX email API endpoints.

    Usage::

        from sendix import SendIX
        client = SendIX("sk_live_xxx")
        result = client.emails.send({"to": "a@b.com", "subject": "Hi", "html": "<p>Hi</p>"})

    Args:
        client: An authenticated :class:`sendix.client.SendIXClient` instance.
    """

    def __init__(self, client: SendIXClient):
        self._client = client

    # ------------------------------------------------------------------
    # Synchronous methods
    # ------------------------------------------------------------------

    def send(self, options: SendEmailOptions) -> dict:
        """Send a single email.

        Args:
            options: Email content and metadata (see :class:`SendEmailOptions`).

        Returns:
            API response containing the message ID and status.
        """
        body = dict(options)
        if "from_email" in body:
            body["from"] = body.pop("from_email")
        return self._client.request("POST", "/v1/emails", body=body)

    def send_batch(self, options: BatchEmailOptions) -> dict:
        """Send a batch of emails in a single API call.

        Args:
            options: Batch payload containing a list of emails.

        Returns:
            API response with per-message results.
        """
        return self._client.request("POST", "/v1/emails/batch", body=dict(options))

    def list(self, options: Optional[ListEmailsOptions] = None) -> dict:
        """Retrieve a paginated list of sent emails.

        Args:
            options: Pagination parameters (page, limit).

        Returns:
            API response with an ``emails`` list and pagination metadata.
        """
        params = {}
        if options:
            params = {k: v for k, v in options.items() if v is not None}
        query = "&".join(f"{k}={v}" for k, v in params.items())
        path = "/v1/emails"
        if query:
            path = f"{path}?{query}"
        return self._client.request("GET", path)

    def get(self, email_id: str) -> dict:
        """Retrieve a single email by its ID.

        Args:
            email_id: The UUID returned when the email was sent.

        Returns:
            Full email object from the API.
        """
        return self._client.request("GET", f"/v1/emails/{email_id}")

    # ------------------------------------------------------------------
    # Async methods
    # ------------------------------------------------------------------

    async def async_send(self, options: SendEmailOptions) -> dict:
        """Async version of :meth:`send`."""
        body = dict(options)
        if "from_email" in body:
            body["from"] = body.pop("from_email")
        return await self._client.async_request("POST", "/v1/emails", body=body)

    async def async_send_batch(self, options: BatchEmailOptions) -> dict:
        """Async version of :meth:`send_batch`."""
        return await self._client.async_request("POST", "/v1/emails/batch", body=dict(options))

    async def async_list(self, options: Optional[ListEmailsOptions] = None) -> dict:
        """Async version of :meth:`list`."""
        params = {}
        if options:
            params = {k: v for k, v in options.items() if v is not None}
        query = "&".join(f"{k}={v}" for k, v in params.items())
        path = "/v1/emails"
        if query:
            path = f"{path}?{query}"
        return await self._client.async_request("GET", path)

    async def async_get(self, email_id: str) -> dict:
        """Async version of :meth:`get`."""
        return await self._client.async_request("GET", f"/v1/emails/{email_id}")
