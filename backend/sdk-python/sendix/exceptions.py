"""Custom exceptions for the SendIX SDK."""


class SendIXError(Exception):
    """Base exception for all SendIX SDK errors.

    Attributes:
        message: Human-readable error description.
        status: HTTP status code returned by the API.
        code: Machine-readable error code from the API.
    """

    def __init__(self, message, status=None, code=None):
        self.message = message
        self.status = status
        self.code = code
        super().__init__(message)


class AuthenticationError(SendIXError):
    """Raised when the API key is invalid or missing (HTTP 401)."""
    pass


class ValidationError(SendIXError):
    """Raised when the request payload fails validation (HTTP 422)."""
    pass


class NotFoundError(SendIXError):
    """Raised when the requested resource does not exist (HTTP 404)."""
    pass


class RateLimitError(SendIXError):
    """Raised when the API rate limit is exceeded (HTTP 429)."""
    pass
