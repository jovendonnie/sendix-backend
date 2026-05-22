# sendix-python

Official Python SDK for [SendIX](https://sendix.io) — Email infrastructure for developers.

## Installation

```bash
pip install sendix-python
```

## Quick Start

```python
from sendix import SendIX

client = SendIX('sk_live_your_api_key')

# Send a single email
result = client.emails.send({
    'to': 'user@example.com',
    'subject': 'Hello from SendIX',
    'html': '<p>Hello world</p>',
})

# Send with template variables
result = client.emails.send({
    'to': 'user@example.com',
    'subject': 'Hi {{name}}',
    'html': '<p>Hi {{name}}, welcome!</p>',
    'variables': {'name': 'Alice'},
})

# Send bulk emails
result = client.emails.send_batch({
    'emails': [
        {'to': 'user1@example.com', 'subject': 'Hi {{name}}', 'html': '<p>Hi {{name}}</p>', 'variables': {'name': 'Alice'}},
        {'to': 'user2@example.com', 'subject': 'Hi {{name}}', 'html': '<p>Hi {{name}}</p>', 'variables': {'name': 'Bob'}},
    ],
})

# Async usage
import asyncio

async def main():
    result = await client.emails.async_send({
        'to': 'user@example.com',
        'subject': 'Async email',
        'html': '<p>Sent async</p>',
    })

asyncio.run(main())
```

## Error Handling

```python
from sendix import SendIX, AuthenticationError, SendIXError

client = SendIX('sk_live_your_api_key')

try:
    result = client.emails.send({
        'to': 'user@example.com',
        'subject': 'Test',
        'html': '<p>Test</p>',
    })
except AuthenticationError as e:
    print(f'Auth error: {e.message}')
except SendIXError as e:
    print(f'Error {e.status}: {e.message} (code: {e.code})')
```

## API Reference

### `SendIX(api_key, base_url="https://api.sendix.io")`

| Method | Description |
|--------|-------------|
| `emails.send(options)` | Send a single email |
| `emails.send_batch(options)` | Send multiple emails |
| `emails.list(options)` | List sent emails |
| `emails.get(email_id)` | Get a single email |
| `webhooks.create(options)` | Create a webhook |
| `webhooks.list()` | List all webhooks |
| `webhooks.delete(webhook_id)` | Delete a webhook |
| `webhooks.deliveries()` | Get webhook delivery logs |

Every sync method has an `async_` counterpart for use with `asyncio`.
