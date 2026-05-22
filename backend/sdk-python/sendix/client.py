"""HTTP client for the SendIX API."""

import json
import urllib.error
import urllib.request
from typing import Optional

from .exceptions import (
    AuthenticationError,
    NotFoundError,
    RateLimitError,
    SendIXError,
    ValidationError,
)


class SendIXClient:
    """Low-level HTTP client that talks to the SendIX REST API.

    All public resource classes (``Emails``, ``Webhooks``) use this
    internally.  You normally do not instantiate it directly; instead
    create a :class:`sendix.SendIX` instance.

    Args:
        api_key: Your SendIX API key (``sk_live_…``).
        base_url: Base URL of the SendIX API.  Defaults to production.
    """

    def __init__(self, api_key: str, base_url: str = "https://api.sendix.io"):
        self.api_key = api_key
        self.base_url = base_url.rstrip('/')

    def _build_url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _build_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": "sendix-python/0.1.0",
        }

    def _handle_error_response(self, status: int, body_str: str):
        """Map HTTP status codes to typed exceptions."""
        try:
            body = json.loads(body_str)
            message = body.get("message", body.get("error", str(body)))
            code = body.get("code")
        except (json.JSONDecodeError, TypeError):
            message = body_str or "Unknown error"
            code = None

        if status == 401:
            raise AuthenticationError(message, status=status, code=code)
        if status == 404:
            raise NotFoundError(message, status=status, code=code)
        if status == 422:
            raise ValidationError(message, status=status, code=code)
        if status == 429:
            raise RateLimitError(message, status=status, code=code)

        raise SendIXError(message, status=status, code=code)

    def request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        """Execute a synchronous HTTP request.

        Args:
            method: HTTP method (``GET``, ``POST``, ``DELETE``, …).
            path: URL path (e.g. ``/v1/emails``).
            body: JSON-serialisable payload for ``POST`` / ``PUT`` requests.

        Returns:
            Parsed JSON response as a dictionary.

        Raises:
            AuthenticationError: Invalid or missing API key.
            NotFoundError: Requested resource does not exist.
            RateLimitError: Too many requests.
            ValidationError: Request payload is invalid.
            SendIXError: Any other API error.
        """
        url = self._build_url(path)
        headers = self._build_headers()

        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(url, data=data, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8") if exc.fp else ""
            self._handle_error_response(exc.code, raw)
        except urllib.error.URLError as exc:
            raise SendIXError(f"Connection error: {exc.reason}") from exc

    async def async_request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        """Execute an asynchronous HTTP request via ``asyncio``.

        This uses :func:`asyncio.loop.run_in_executor` under the hood so
        it does **not** require any third-party HTTP library.

        Refer to :meth:`request` for parameter and return documentation.
        """
        import asyncio
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self.request, method, path, body)
