import type { SendIXConfig, SendIXError } from './types.js'

export class SendIXClient {
  private apiKey: string
  private baseUrl: string

  constructor(config: SendIXConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://api.sendix.io'
  }

  /**
   * Makes an authenticated HTTP request to the SendIX API.
   * Throws a SendIXError on non-2xx responses.
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }

    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }

    let response: Response
    try {
      response = await fetch(url, init)
    } catch (cause) {
      const err = new Error('Network error: failed to reach SendIX API') as SendIXError
      err.code = 'NETWORK_ERROR'
      throw err
    }

    let payload: any
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      payload = await response.json()
    } else {
      payload = { error: await response.text() }
    }

    if (!response.ok) {
      const err = new Error(
        payload?.error ?? payload?.message ?? `HTTP ${response.status}`
      ) as SendIXError
      err.status = response.status
      err.code = payload?.code
      throw err
    }

    return payload as T
  }
}