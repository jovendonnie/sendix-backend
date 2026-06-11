import * as crypto from 'crypto'
import { saveEvent, resolveMessageIdByProvider } from './event.service'
import { db } from '../lib/db'

export type NormalizedEvent = {
  providerMessageId: string | null
  eventType: string
  occurredAt: Date
  metadata: Record<string, any>
}

// ── Resend ──────────────────────────────────────────────────────────────────

export function parseResendEvent(payload: any): NormalizedEvent | null {
  const type: string = payload.type || ''
  const data = payload.data || {}

  const EVENT_MAP: Record<string, string> = {
    'email.delivered':    'delivered',
    'email.bounced':      'bounced',
    'email.opened':       'opened',
    'email.clicked':      'clicked',
    'email.complained':   'complained',
    'email.unsubscribed': 'unsubscribed',
  }

  const eventType = EVENT_MAP[type]
  if (!eventType) return null

  const occurredAt = data.created_at ? new Date(data.created_at) : new Date()
  const metadata: Record<string, any> = {}

  if (data.click?.link) metadata.url = data.click.link
  if (data.bounce?.type) metadata.bounce_type = data.bounce.type.toLowerCase()
  if (data.email_id) metadata.email_id = data.email_id

  return {
    providerMessageId: data.email_id || null,
    eventType,
    occurredAt,
    metadata,
  }
}

// ── Brevo ───────────────────────────────────────────────────────────────────

export function parseBrevoEvent(payload: any): NormalizedEvent | null {
  const event: string = payload.event || ''

  const EVENT_MAP: Record<string, string> = {
    delivered:       'delivered',
    hard_bounce:     'bounced',
    soft_bounce:     'soft_bounce',
    opened:          'opened',
    click:           'clicked',
    spam:            'complained',
    unsubscribed:    'unsubscribed',
  }

  const eventType = EVENT_MAP[event]
  if (!eventType) return null

  const occurredAt = payload.date ? new Date(payload.date) : new Date()
  const metadata: Record<string, any> = {}

  if (payload.link) metadata.url = payload.link
  if (payload.reason) metadata.bounce_reason = payload.reason

  return {
    providerMessageId: payload['message-id'] || null,
    eventType,
    occurredAt,
    metadata,
  }
}

// ── AWS SES (SNS) ────────────────────────────────────────────────────────────

export function parseSesEvent(payload: any): NormalizedEvent | null {
  let body = payload
  if (typeof payload.Message === 'string') {
    try { body = JSON.parse(payload.Message) } catch { return null }
  }

  const notifType: string = body.notificationType || ''

  const EVENT_MAP: Record<string, string> = {
    Delivery:  'delivered',
    Bounce:    'bounced',
    Complaint: 'complained',
    Send:      'sent',
  }

  const eventType = EVENT_MAP[notifType]
  if (!eventType) return null

  const metadata: Record<string, any> = {}

  if (body.bounce?.bounceType === 'Transient') metadata.bounce_type = 'soft'
  else if (body.bounce?.bounceType === 'Permanent') metadata.bounce_type = 'hard'

  const msgId = body.mail?.messageId || null
  const timestamp = body.mail?.timestamp ? new Date(body.mail.timestamp) : new Date()

  return {
    providerMessageId: msgId,
    eventType,
    occurredAt: timestamp,
    metadata,
  }
}

// ── Mailgun ──────────────────────────────────────────────────────────────────

export function parseMailgunEvent(payload: any): NormalizedEvent | null {
  const eventData = payload['event-data'] || payload
  const event: string = eventData.event || ''

  const EVENT_MAP: Record<string, string> = {
    delivered:   'delivered',
    failed:      'bounced',
    opened:      'opened',
    clicked:     'clicked',
    complained:  'complained',
    unsubscribed: 'unsubscribed',
  }

  const eventType = EVENT_MAP[event]
  if (!eventType) return null

  const metadata: Record<string, any> = {}
  if (eventData.url) metadata.url = eventData.url
  if (eventData['delivery-status']?.['message']) metadata.bounce_reason = eventData['delivery-status']['message']

  const occurredAt = eventData.timestamp
    ? new Date(eventData.timestamp * 1000)
    : new Date()

  return {
    providerMessageId: eventData.message?.headers?.['message-id'] || null,
    eventType,
    occurredAt,
    metadata,
  }
}

// ── Postmark ─────────────────────────────────────────────────────────────────

export function parsePostmarkEvent(payload: any): NormalizedEvent | null {
  const recordType: string = payload.RecordType || ''

  const EVENT_MAP: Record<string, string> = {
    Delivery:   'delivered',
    Bounce:     'bounced',
    Open:       'opened',
    Click:      'clicked',
    SpamComplaint: 'complained',
    SubscriptionChange: 'unsubscribed',
  }

  const eventType = EVENT_MAP[recordType]
  if (!eventType) return null

  const metadata: Record<string, any> = {}
  if (payload.OriginalLink) metadata.url = payload.OriginalLink
  if (payload.Type) metadata.bounce_type = payload.Type === 'SoftBounce' ? 'soft' : 'hard'

  const occurredAt = payload.DeliveredAt || payload.BouncedAt || payload.ReceivedAt
    ? new Date(payload.DeliveredAt || payload.BouncedAt || payload.ReceivedAt)
    : new Date()

  return {
    providerMessageId: payload.MessageID || null,
    eventType,
    occurredAt,
    metadata,
  }
}

// ── Provider detector ────────────────────────────────────────────────────────

export type IngestProvider = 'resend' | 'brevo' | 'ses' | 'mailgun' | 'postmark' | 'unknown'

export function detectProvider(headers: Record<string, string | string[] | undefined>, body: any): IngestProvider {
  const ua = (headers['user-agent'] || '').toString().toLowerCase()
  const ct = (headers['content-type'] || '').toString().toLowerCase()

  if (ua.includes('resend') || body?.type?.startsWith('email.')) return 'resend'
  if (headers['x-brevo-event'] || body?.event === 'delivered' && body?.['message-id']) return 'brevo'
  if (body?.Type === 'Notification' && body?.TopicArn) return 'ses'
  if (body?.['event-data'] || body?.domain) return 'mailgun'
  if (body?.RecordType) return 'postmark'
  return 'unknown'
}

// ── Main ingest handler ──────────────────────────────────────────────────────

export async function ingestWebhookEvent(
  userId: string,
  headers: Record<string, string | string[] | undefined>,
  body: any
): Promise<{ saved: boolean; eventType?: string; error?: string }> {
  const providerName = detectProvider(headers, body)

  let normalized: NormalizedEvent | null = null

  switch (providerName) {
    case 'resend':   normalized = parseResendEvent(body);   break
    case 'brevo':    normalized = parseBrevoEvent(body);    break
    case 'ses':      normalized = parseSesEvent(body);      break
    case 'mailgun':  normalized = parseMailgunEvent(body);  break
    case 'postmark': normalized = parsePostmarkEvent(body); break
    default:
      // Try all parsers as fallback
      normalized = parseResendEvent(body) || parseBrevoEvent(body) || parseSesEvent(body) || null
  }

  if (!normalized) {
    console.warn(`[ingest] Could not parse event from provider: ${providerName}`, JSON.stringify(body).slice(0, 200))
    return { saved: false, error: 'Unrecognized event format' }
  }

  // Try to resolve message_id from provider_message_id
  let messageId: string | null = null
  if (normalized.providerMessageId) {
    messageId = await resolveMessageIdByProvider(normalized.providerMessageId, userId)
  }

  await saveEvent({
    userId,
    messageId,
    providerMessageId: normalized.providerMessageId,
    providerName: providerName === 'unknown' ? 'unknown' : providerName,
    eventType: normalized.eventType,
    occurredAt: normalized.occurredAt,
    rawPayload: body,
    metadata: normalized.metadata,
  })

  // Update message final_status if we have a messageId
  if (messageId && ['delivered', 'bounced', 'soft_bounce', 'complained'].includes(normalized.eventType)) {
    const statusMap: Record<string, string> = {
      delivered: 'delivered',
      bounced: 'bounced',
      soft_bounce: 'soft_bounce',
      complained: 'complained',
    }
    const newStatus = statusMap[normalized.eventType]
    if (newStatus) {
      await db.query(
        "UPDATE messages SET final_status = $1 WHERE id = $2",
        [newStatus, messageId]
      )
    }
  }

  return { saved: true, eventType: normalized.eventType }
}

// ── SNS subscription confirmation ───────────────────────────────────────────

export async function confirmSnsSubscription(subscribeUrl: string): Promise<void> {
  try {
    await fetch(subscribeUrl)
    console.log('[ingest] SNS subscription confirmed')
  } catch (err: any) {
    console.error('[ingest] Failed to confirm SNS subscription:', err.message)
  }
}
