"""TypedDict definitions for type hints in the SendIX SDK."""

from typing import TypedDict, Optional, List, Literal


class SendEmailOptions(TypedDict):
    """Options for sending a single email.

    Attributes:
        to: Recipient email address or list of addresses.
        subject: Email subject line.
        html: HTML content of the email.
        text: Plain text content of the email.
        from_email: Sender email address (maps to ``from`` in the API).
        variables: Template variables for dynamic content.
    """
    to: str | List[str]
    subject: str
    html: Optional[str]
    text: Optional[str]
    from_email: Optional[str]
    variables: Optional[dict]


class BatchEmailOptions(TypedDict):
    """Options for sending a batch of emails.

    Attributes:
        emails: List of individual email options to send.
    """
    emails: List[SendEmailOptions]


class WebhookOptions(TypedDict):
    """Options for creating a webhook.

    Attributes:
        url: HTTPS endpoint that will receive webhook events.
        events: List of event types to subscribe to.
        secret: Secret key used to sign webhook payloads.
    """
    url: str
    events: List[Literal['email.delivered', 'email.failed', 'email.bounced', 'email.spam']]
    secret: str


class ListEmailsOptions(TypedDict, total=False):
    """Options for listing emails with pagination.

    Attributes:
        page: Page number for pagination.
        limit: Number of results per page.
    """
    page: int
    limit: int
