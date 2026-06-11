import { Router, Response } from 'express'
import { db } from '../lib/db'
import { authApiKey, AuthenticatedRequest } from '../middleware/authApiKey'
import { checkEmailLimit, incrementEmailCounter } from '../middleware/checkPlanLimits'
import { orchestrateEmail, updateMessageOrchestration } from '../services/orchestrator.service'
import { filterSuppressedEmails } from '../services/suppression.service'

const router = Router()

function applyVariables(html: string, vars: Record<string, string>) {
  let result = html
  for (const key of Object.keys(vars || {})) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), vars[key])
  }
  return result
}

router.post('/', authApiKey, checkEmailLimit, async (req: AuthenticatedRequest, res: Response) => {
  let messageId: string | null = null

  try {
    const apiKey = req.apiKey
    if (!apiKey) return res.status(401).json({ error: 'Invalid API key' })

    const userId = apiKey.user_id

    // Support both legacy field names (to_email) and new spec (to)
    const to_email: string = req.body.to || req.body.to_email
    const subject: string = req.body.subject
    const html: string    = req.body.html
    const from_email: string | undefined = req.body.from || req.body.from_email
    const variables: Record<string, string> = req.body.variables || {}
    const idempotency_key: string | undefined = req.body.idempotency_key

    if (!to_email || !subject || !html) {
      return res.status(400).json({ error: 'Missing required fields: to (or to_email), subject, html' })
    }

    // Idempotency check
    if (idempotency_key) {
      const { rows: existing } = await db.query(
        "SELECT id, status, provider_used FROM messages WHERE idempotency_key = $1 AND user_id = $2 LIMIT 1",
        [idempotency_key, userId]
      )
      if (existing[0]) {
        return res.json({
          success: true,
          message_id: existing[0].id,
          messageId: existing[0].id,
          provider_used: existing[0].provider_used,
          status: existing[0].status,
          idempotent: true,
        })
      }
    }

    // Suppression check
    const { suppressed: suppressedList } = await filterSuppressedEmails([to_email], userId)
    if (suppressedList.length > 0) {
      const { rows: msgRows } = await db.query(
        `INSERT INTO messages (user_id, api_key_id, to_email, from_email, subject, html, status, final_status, organization_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, 'suppressed', 'suppressed', $7, $8) RETURNING id`,
        [userId, apiKey.id, to_email, from_email || null, subject, html, apiKey.organization_id ?? null, idempotency_key ?? null]
      )
      return res.json({ success: true, message_id: msgRows[0]?.id, messageId: msgRows[0]?.id, suppressed: true })
    }

    const finalHtml = applyVariables(html, variables)

    // Create message record
    const { rows: msgRows } = await db.query(
      `INSERT INTO messages
         (user_id, api_key_id, to_email, from_email, subject, html, status, organization_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
       RETURNING id`,
      [userId, apiKey.id, to_email, from_email || null, subject, finalHtml, apiKey.organization_id ?? null, idempotency_key ?? null]
    )

    if (!msgRows[0]) return res.status(500).json({ error: 'Failed to create message record' })
    messageId = msgRows[0].id

    // Orchestrate through developer's providers
    const result = await orchestrateEmail(
      { to: to_email, from: from_email, subject, html: finalHtml },
      userId
    )

    if (!result.success) {
      await db.query(
        "UPDATE messages SET status = 'failed', final_status = 'failed', provider_used = $1, retry_count = $2 WHERE id = $3",
        [result.provider_used ?? null, result.retry_count ?? 0, messageId]
      )
      await db.query(
        'INSERT INTO logs (message_id, status, error, provider) VALUES ($1, $2, $3, $4)',
        [messageId, 'failed', result.error, result.provider_used ?? 'none']
      )
      return res.status(500).json({ error: result.error || 'Email send failed' })
    }

    await updateMessageOrchestration(messageId!, result, result.messageId)

    await db.query(
      'INSERT INTO logs (message_id, status, provider) VALUES ($1, $2, $3)',
      [messageId, 'sent', result.provider_used]
    )

    incrementEmailCounter(userId, 1).catch(() => {})

    return res.json({
      success: true,
      message_id: messageId,
      messageId,
      provider_used: result.provider_used,
      status: 'sent',
    })

  } catch (err: any) {
    console.error('[send] Error:', err)
    if (messageId) {
      await db.query("UPDATE messages SET status = 'failed', final_status = 'failed' WHERE id = $1", [messageId])
        .catch(() => {})
      await db.query(
        'INSERT INTO logs (message_id, status, error) VALUES ($1, $2, $3)',
        [messageId, 'failed', err.message]
      ).catch(() => {})
    }
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
