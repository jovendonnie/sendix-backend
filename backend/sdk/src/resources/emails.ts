import type { SendIXClient } from '../client.js'
import type {
  BatchEmailOptions,
  BatchEmailResponse,
  Email,
  ListEmailsOptions,
  ListEmailsResponse,
  SendEmailOptions,
  SendEmailResponse,
} from '../types.js'

export class Emails {
  constructor(private readonly client: SendIXClient) {}

  /**
   * Send a single transactional email.
   * @param options - Recipient, subject, and content options.
   */
  async send(options: SendEmailOptions): Promise<SendEmailResponse> {
    return this.client.request<SendEmailResponse>('POST', '/v1/emails', options)
  }

  /**
   * Send a batch of emails in a single request.
   * @param options - Array of email objects to send.
   */
  async sendBatch(options: BatchEmailOptions): Promise<BatchEmailResponse> {
    return this.client.request<BatchEmailResponse>('POST', '/v1/emails/batch', options)
  }

  /**
   * List previously sent emails with pagination.
   * @param options - Optional page and limit parameters.
   */
  async list(options: ListEmailsOptions = {}): Promise<ListEmailsResponse> {
    const params = new URLSearchParams()
    if (options.page !== undefined) params.set('page', String(options.page))
    if (options.limit !== undefined) params.set('limit', String(options.limit))

    const query = params.toString() ? `?${params.toString()}` : ''
    return this.client.request<ListEmailsResponse>('GET', `/v1/emails${query}`)
  }

  /**
   * Retrieve a single email record by ID.
   * @param id - The email message ID.
   */
  async get(id: string): Promise<{ success: boolean; data?: { email: Email } }> {
    return this.client.request<{ success: boolean; data?: { email: Email } }>(
      'GET',
      `/v1/emails/${id}`
    )
  }
}