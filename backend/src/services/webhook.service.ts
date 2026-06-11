import * as crypto from 'crypto'
import { db } from '../lib/db'

const ALLOWED_EVENTS = ['email.delivered', 'email.bounced', 'email.failed', 'email.spam']
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

export async function createWebhook(userId: string, url: string, events: string[], secret: string) {
  const { rows } = await db.query(
    `INSERT INTO webhooks (user_id, url, events, secret, active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING *`,
    [userId, url, JSON.stringify(events), secret]
  )
  if (!rows[0]) throw new Error('Failed to create webhook')
  return rows[0]
}

export async function getUserWebhooks(userId: string) {
  const { rows } = await db.query(
    `SELECT * FROM webhooks
     WHERE user_id = $1 AND active = true
     ORDER BY created_at DESC`,
    [userId]
  )
  return rows
}

export async function deleteWebhook(id: string, userId: string) {
  await db.query(
    'UPDATE webhooks SET active = false WHERE id = $1 AND user_id = $2',
    [id, userId]
  )
}

export async function deliverWebhook(webhookId: string, event: string, payload: any) {
  const { rows } = await db.query(
    'SELECT url, secret FROM webhooks WHERE id = $1',
    [webhookId]
  )
  const webhook = rows[0]
  if (!webhook) {
    console.error('[webhook] Not found:', webhookId)
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

      await db.query(
        `INSERT INTO webhook_deliveries (webhook_id, event, payload, status, response_status, error, attempt)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          webhookId, event, JSON.stringify(payload),
          response.ok ? 'success' : 'failed',
          response.status,
          response.ok ? null : `HTTP ${response.status}`,
          attempt,
        ]
      )

      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (err: any) {
      lastError = err.message
      if (attempt === MAX_RETRIES) {
        await db.query(
          `INSERT INTO webhook_deliveries (webhook_id, event, payload, status, response_status, error, attempt)
           VALUES ($1, $2, $3, 'failed', null, $4, $5)`,
          [webhookId, event, JSON.stringify(payload), lastError, attempt]
        ).catch(() => {})
      }
    }

    if (attempt < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}

export async function triggerWebhooks(userId: string, event: string, payload: any) {
  try {
    const { rows: webhooks } = await db.query(
      `SELECT id, url, events FROM webhooks
       WHERE user_id = $1 AND active = true`,
      [userId]
    )

    if (!webhooks || webhooks.length === 0) return

    for (const webhook of webhooks) {
      const subscribedEvents: string[] = Array.isArray(webhook.events)
        ? webhook.events
        : JSON.parse(webhook.events || '[]')

      if (subscribedEvents.includes(event)) {
        deliverWebhook(webhook.id, event, payload).catch(err => {
          console.error(`[webhook] Delivery failed for ${webhook.id}:`, err)
        })
      }
    }
  } catch (err) {
    console.error('[webhook] Error triggering webhooks:', err)
  }
}
