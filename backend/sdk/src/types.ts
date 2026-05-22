export interface SendIXConfig {
  apiKey: string
  /** @default 'https://api.sendix.io' */
  baseUrl?: string
}

export interface SendEmailOptions {
  to: string | string[]
  from?: string
  subject: string
  html?: string
  text?: string
  variables?: Record<string, string>
}

export interface SendEmailResponse {
  success: boolean
  data?: {
    messageId: string
    status: string
  }
  error?: string
}

export interface BatchEmailOptions {
  emails: SendEmailOptions[]
}

export interface BatchEmailResponse {
  success: boolean
  data?: {
    total: number
    sent: number
    failed: number
    results: Array<{ success: boolean; email: string; error?: string }>
  }
  error?: string
}

export interface Email {
  id: string
  to_email: string
  subject: string
  status: string
  created_at: string
}

export interface ListEmailsOptions {
  page?: number
  limit?: number
}

export interface ListEmailsResponse {
  success: boolean
  data?: {
    emails: Email[]
    page: number
    limit: number
    total: number
  }
  error?: string
}

export interface WebhookOptions {
  url: string
  events: ('email.delivered' | 'email.failed' | 'email.bounced' | 'email.spam')[]
  secret: string
}

export interface WebhookResponse {
  success: boolean
  data?: { webhook: any }
  error?: string
}

export interface SendIXError extends Error {
  code?: string
  status?: number
}