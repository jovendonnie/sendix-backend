import { SendIXClient } from './client.js'
import { Emails } from './resources/emails.js'
import { Webhooks } from './resources/webhooks.js'
import type { SendIXConfig } from './types.js'

export class SendIX {
  /** Email sending and retrieval methods. */
  readonly emails: Emails
  /** Webhook registration and delivery methods. */
  readonly webhooks: Webhooks

  constructor(apiKey: string, options?: { baseUrl?: string }) {
    const config: SendIXConfig = { apiKey, baseUrl: options?.baseUrl }
    const client = new SendIXClient(config)
    this.emails = new Emails(client)
    this.webhooks = new Webhooks(client)
  }
}

export default SendIX

export type {
  BatchEmailOptions,
  BatchEmailResponse,
  Email,
  ListEmailsOptions,
  ListEmailsResponse,
  SendEmailOptions,
  SendEmailResponse,
  SendIXConfig,
  SendIXError,
  WebhookOptions,
  WebhookResponse,
} from './types.js'