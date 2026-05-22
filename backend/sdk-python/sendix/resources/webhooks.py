"""Webhook resource for the SendIX SDK."""

from ..client import SendIXClient
from ..types import WebhookOptions


class Webhooks:
    """Wraps the SendIX webhook API endpoints.

    Usage::

        from sendix import SendIX
        client = SendIX("sk_live_xxx")
        wh = client.webhooks.create({"url": "https://…", "events": […], "secret": "…"})

    Args:
        client: An authenticated :class:`sendix.client.SendIXClient` instance.
    """

    def __init__(self, client: SendIXClient):
        self._client = client

    def create(self, options: WebhookOptions) -> dict:
        """Register a new webhook endpoint.

        Args:
            options: Webhook configuration (see :class:`WebhookOptions`).

        Returns:
            The created webhook object with its ID and signing secret.
        """
        return self._client.request("POST", "/v1/webhooks", body=dict(options))

    def list(self) -> dict:
        """List all registered webhooks for the authenticated account.

        Returns:
            API response containing a list of webhook objects.
        """
        return self._client.request("GET", "/v1/webhooks")

    def delete(self, webhook_id: str) -> dict:
        """Remove a webhook by its ID.

        Args:
            webhook_id: UUID of the webhook to delete.

        Returns:
            Confirmation message from the API.
        """
        return self._client.request("DELETE", f"/v1/webhooks/{webhook_id}")

    def deliveries(self) -> dict:
        """Retrieve recent webhook delivery attempts.

        Returns:
            API response containing a list of delivery logs.
        """
        return self._client.request("GET", "/v1/webhooks/deliveries")
