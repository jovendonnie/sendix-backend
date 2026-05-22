# @sendix/node

Official Node.js SDK for SendIX — Email infrastructure for developers.

## Installation

```bash
npm install @sendix/node
```

## Quick Start

```typescript
import SendIX from '@sendix/node'

const sendix = new SendIX('sk_live_your_api_key')

// Send a single email
const result = await sendix.emails.send({
  to: 'user@example.com',
  subject: 'Hello from SendIX',
  html: '<p>Hello world</p>'
})

// Send bulk emails
const batch = await sendix.emails.sendBatch({
  emails: [
    { to: 'user1@example.com', subject: 'Hi {{name}}', html: '<p>Hi {{name}}</p>', variables: { name: 'Alice' } },
    { to: 'user2@example.com', subject: 'Hi {{name}}', html: '<p>Hi {{name}}</p>', variables: { name: 'Bob' } }
  ]
})

// List sent emails
const emails = await sendix.emails.list({ page: 1, limit: 20 })

// Get a single email
const email = await sendix.emails.get('msg_abc123')

// Create a webhook
await sendix.webhooks.create({
  url: 'https://yourapp.com/webhooks/sendix',
  events: ['email.delivered', 'email.failed'],
  secret: 'your_webhook_secret'
})

// List webhooks
const hooks = await sendix.webhooks.list()

// Delete a webhook
await sendix.webhooks.delete('wh_abc123')

// View recent webhook deliveries
const deliveries = await sendix.webhooks.deliveries()
```

## Custom Base URL

```typescript
const sendix = new SendIX('sk_live_your_api_key', {
  baseUrl: 'http://localhost:3001'  // point to local backend during development
})
```

## Error Handling

```typescript
import SendIX from '@sendix/node'
import type { SendIXError } from '@sendix/node'

const sendix = new SendIX('sk_live_your_api_key')

try {
  await sendix.emails.send({
    to: 'user@example.com',
    subject: 'Test',
    html: '<p>Test</p>'
  })
} catch (error) {
  const e = error as SendIXError
  console.error(e.message)  // Human-readable error message
  console.error(e.status)   // HTTP status code (e.g. 401, 422, 500)
  console.error(e.code)     // Error code from API (e.g. 'INVALID_KEY')
}
```

## TypeScript Support

All methods are fully typed. Import types directly:

```typescript
import type {
  SendEmailOptions,
  SendEmailResponse,
  BatchEmailOptions,
  BatchEmailResponse,
  ListEmailsOptions,
  ListEmailsResponse,
  Email,
  WebhookOptions,
  WebhookResponse,
  SendIXError,
} from '@sendix/node'
```

## Requirements

- Node.js 18+ (uses native `fetch`)
- No additional runtime dependencies

## License

MIT