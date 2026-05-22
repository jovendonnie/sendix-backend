import type { SendIXClient } from '../client.js'
import type { WebhookOptions, WebhookResponse } from '../types.js'

export class Webhooks {
  constructor(private readonly client: SendIXClient) {}

  /**
   * Register a new webhook endpoint for one or more events.
   * @param options - Target URL, event types, and signing secret.
   */
  async create(options: WebhookOptions): Promise<WebhookResponse> {
    return this.client.request<WebhookResponse>('POST', '/v1/webhooks', options)
  }

  /**
   * List all registered webhooks for the current account.
   */
  async list(): Promise<{ success: boolean; data?: { webhooks: any[] } }> {
    return this.client.request<{ success: boolean; data?: { webhooks: any[] } }>(
      'GET',
      '/v1/webhooks'
    )
  }

  /**
   * Delete a webhook by ID.
   * @param id - The webhook ID to remove.
   */
  async delete(id: string): Promise<{ success: boolean }> {
    return this.client.request<{ success: boolean }>('DELETE', `/v1/webhooks/${id}`)
  }

  /**
   * List recent webhook delivery attempts and their results.
   */
  async deliveries(): Promise<{ success: boolean; data?: { deliveries: any[] } }> {
    return this.client.request<{ success: boolean; data?: { deliveries: any[] } }>(
      'GET',
      '/v1/webhooks/deliveries'
    )
  }
}