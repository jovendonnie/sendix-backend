import { db } from '../lib/db'

export interface EmailEvent {
  id: string
  user_id: string
  message_id: string | null
  provider_message_id: string | null
  provider_name: string
  event_type: string
  occurred_at: string
  metadata: Record<string, any> | null
  created_at: string
}

export interface EventStats {
  period: string
  total: number
  delivered: number
  bounced: number
  opened: number
  clicked: number
  complained: number
  deliveryRate: number
  bounceRate: number
  openRate: number
}

export async function listEvents(
  userId: string,
  filters: {
    messageId?: string
    eventType?: string
    providerName?: string
    from?: string
    to?: string
    limit?: number
    offset?: number
  } = {}
): Promise<EmailEvent[]> {
  const conditions: string[] = ['e.user_id = $1']
  const values: any[] = [userId]
  let idx = 2

  if (filters.messageId) {
    conditions.push(`e.message_id = $${idx++}`)
    values.push(filters.messageId)
  }
  if (filters.eventType) {
    conditions.push(`e.event_type = $${idx++}`)
    values.push(filters.eventType)
  }
  if (filters.providerName) {
    conditions.push(`e.provider_name = $${idx++}`)
    values.push(filters.providerName)
  }
  if (filters.from) {
    conditions.push(`e.occurred_at >= $${idx++}`)
    values.push(filters.from)
  }
  if (filters.to) {
    conditions.push(`e.occurred_at <= $${idx++}`)
    values.push(filters.to)
  }

  const limit = Math.min(filters.limit ?? 100, 500)
  const offset = filters.offset ?? 0

  const { rows } = await db.query(
    `SELECT e.id, e.user_id, e.message_id, e.provider_message_id,
            e.provider_name, e.event_type, e.occurred_at, e.metadata, e.created_at
     FROM email_events e
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.occurred_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...values, limit, offset]
  )
  return rows
}

export async function getEventsByMessage(messageId: string, userId: string): Promise<EmailEvent[]> {
  const { rows } = await db.query(
    `SELECT id, user_id, message_id, provider_message_id, provider_name,
            event_type, occurred_at, metadata, created_at
     FROM email_events
     WHERE message_id = $1 AND user_id = $2
     ORDER BY occurred_at ASC`,
    [messageId, userId]
  )
  return rows
}

export async function getStats(userId: string, periodDays: number = 7): Promise<EventStats> {
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString()

  const { rows } = await db.query(
    `SELECT event_type, COUNT(*) as count
     FROM email_events
     WHERE user_id = $1 AND occurred_at >= $2
     GROUP BY event_type`,
    [userId, since]
  )

  const counts: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    counts[row.event_type] = parseInt(row.count, 10)
    total += parseInt(row.count, 10)
  }

  const delivered = (counts.delivered ?? 0) + (counts.sent ?? 0)
  const bounced = (counts.bounced ?? 0) + (counts.soft_bounce ?? 0)
  const opened = counts.opened ?? 0
  const clicked = counts.clicked ?? 0
  const complained = counts.complained ?? 0

  return {
    period: `${periodDays}d`,
    total,
    delivered,
    bounced,
    opened,
    clicked,
    complained,
    deliveryRate: total > 0 ? (delivered / total) * 100 : 0,
    bounceRate: total > 0 ? (bounced / total) * 100 : 0,
    openRate: delivered > 0 ? (opened / delivered) * 100 : 0,
  }
}

export async function saveEvent(event: {
  userId: string
  messageId?: string | null
  providerMessageId?: string | null
  providerName: string
  eventType: string
  occurredAt: Date
  rawPayload?: any
  metadata?: any
}): Promise<EmailEvent> {
  const { rows } = await db.query(
    `INSERT INTO email_events
       (user_id, message_id, provider_message_id, provider_name, event_type, occurred_at, raw_payload, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      event.userId,
      event.messageId ?? null,
      event.providerMessageId ?? null,
      event.providerName,
      event.eventType,
      event.occurredAt.toISOString(),
      event.rawPayload ? JSON.stringify(event.rawPayload) : null,
      event.metadata ? JSON.stringify(event.metadata) : null,
    ]
  )
  return rows[0]
}

export async function resolveMessageIdByProvider(
  providerMessageId: string,
  userId: string
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT id FROM messages WHERE provider_message_id = $1 AND user_id = $2 LIMIT 1`,
    [providerMessageId, userId]
  )
  return rows[0]?.id ?? null
}
