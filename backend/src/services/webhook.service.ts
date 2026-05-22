import * as crypto from 'crypto'
import { supabaseAdmin } from '../lib/supabaseAdmin'

const ALLOWED_EVENTS = ['email.delivered', 'email.bounced', 'email.failed', 'email.spam']
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

/**
 * Create a new webhook for a user.
 * @param userId - The user ID
 * @param url - The webhook URL
 * @param events - Array of event types to subscribe to
 * @param secret - Secret for HMAC signature
 * @returns The created webhook
 */
export async function createWebhook(userId: string, url: string, events: string[], secret: string) {
  const { data, error } = await supabaseAdmin
    .from('webhooks')
    .insert({
      user_id: userId,
      url,
      events,
      secret,
      active: true,
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to create webhook: ${error.message}`)
  return data
}

/**
 * Get all active webhooks for a user.
 * @param userId - The user ID
 * @returns Array of webhooks
 */
export async function getUserWebhooks(userId: string) {
  const { data, error } = await supabaseAdmin
    .from('webhooks')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Failed to fetch webhooks: ${error.message}`)
  return data || []
}

/**
 * Soft delete a webhook by setting active=false.
 * @param id - The webhook ID
 * @param userId - The user ID for ownership check
 */
export async function deleteWebhook(id: string, userId: string) {
  const { error } = await supabaseAdmin
    .from('webhooks')
    .update({ active: false })
    .eq('id', id)
    .eq('user_id', userId)

  if (error) throw new Error(`Failed to delete webhook: ${error.message}`)
}

/**
 * Deliver a webhook event to the target URL with retry logic.
 * @param webhookId - The webhook ID
 * @param event - The event type
 * @param payload - The payload to send
 */
export async function deliverWebhook(webhookId: string, event: string, payload: any) {
  const { data: webhook, error: webhookError } = await supabaseAdmin
    .from('webhooks')
    .select('url, secret')
    .eq('id', webhookId)
    .single()

  if (webhookError || !webhook) {
    console.error('Webhook not found:', webhookId)
    return
  }

  const payloadString = JSON.stringify(payload)
  const signature = crypto.createHmac('sha256', webhook.secret).update(payloadString).digest('hex')

  let lastError: string | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SendIX-Event': event,
          'X-SendIX-Signature': signature,
        },
        body: payloadString,
      })

      const delivery = {
        webhook_id: webhookId,
        event,
        payload: payload,
        status: response.ok ? 'success' : 'failed',
        response_status: response.status,
        error: response.ok ? null : `HTTP ${response.status}`,
        attempt,
      }

      await supabaseAdmin
        .from('webhook_deliveries')
        .insert(delivery)

      if (response.ok) return

      lastError = `HTTP ${response.status}`
    } catch (err: any) {
      lastError = err.message

      if (attempt === MAX_RETRIES) {
        await supabaseAdmin
          .from('webhook_deliveries')
          .insert({
            webhook_id: webhookId,
            event,
            payload: payload,
            status: 'failed',
            response_status: null,
            error: lastError,
            attempt,
          })
      }
    }

    if (attempt < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}

/**
 * Trigger all active webhooks for a user that subscribe to a specific event.
 * @param userId - The user ID
 * @param event - The event type
 * @param payload - The payload to send
 */
export async function triggerWebhooks(userId: string, event: string, payload: any) {
  try {
    const { data: webhooks, error } = await supabaseAdmin
      .from('webhooks')
      .select('id, url, events')
      .eq('user_id', userId)
      .eq('active', true)
      .contains('events', [event])

    if (error) {
      console.error('Failed to fetch webhooks:', error)
      return
    }

    if (!webhooks || webhooks.length === 0) return

    for (const webhook of webhooks) {
      deliverWebhook(webhook.id, event, payload).catch(err => {
        console.error(`Webhook delivery failed for ${webhook.id}:`, err)
      })
    }
  } catch (err) {
    console.error('Error triggering webhooks:', err)
  }
}
