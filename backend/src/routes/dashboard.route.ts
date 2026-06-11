import { Router, Response } from 'express'
import { db } from '../lib/db'
import { authClerkUser, UserRequest } from '../middleware/authClerkUser'
import { sendEmail } from '../services/email.service'
import { incrementEmailCounter } from '../middleware/checkPlanLimits'

const router = Router()

/**
 * GET /api/dashboard/messages
 * Returns messages for the logged-in user (Clerk JWT auth).
 * Used by the Logs and Analytics dashboard pages.
 */
router.get('/messages', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!
    const days   = Math.min(365, parseInt(req.query.days as string) || 30)

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)

    const { rows: messages } = await db.query(
      `SELECT id, user_id, api_key_id, to_email, from_email, subject, status,
              ses_message_id, created_at
       FROM messages
       WHERE user_id = $1 AND created_at >= $2
       ORDER BY created_at DESC
       LIMIT 2000`,
      [userId, cutoff.toISOString()]
    )

    // Fetch logs for these messages
    const messageIds = messages.map((m: any) => m.id)
    let logs: any[] = []
    if (messageIds.length > 0) {
      const { rows } = await db.query(
        `SELECT id, message_id, status, error, provider, created_at
         FROM logs
         WHERE message_id = ANY($1)`,
        [messageIds]
      )
      logs = rows
    }

    return res.json({ messages, logs })
  } catch (err) {
    console.error('[dashboard/messages] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/dashboard/send-email
 * Sends a test email from the dashboard (Clerk JWT auth).
 * Used by the Send page in the dashboard.
 */
router.post('/send-email', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!
    const { to_email, subject, html, from_email, variables } = req.body

    if (!to_email || !subject || !html) {
      return res.status(400).json({ error: 'Missing required fields: to_email, subject, html' })
    }

    // Apply variables
    let finalHtml = html
    if (variables && typeof variables === 'object') {
      Object.keys(variables).forEach(key => {
        finalHtml = finalHtml.replace(new RegExp(`{{${key}}}`, 'g'), variables[key])
      })
    }

    const fromEmailResolved = from_email || process.env.AWS_SES_FROM_EMAIL || 'notificaciones@mail-sendix.com'
    const provider = (process.env.EMAIL_PROVIDER ?? 'ses').toLowerCase()

    const { rows: msgRows } = await db.query(
      `INSERT INTO messages (user_id, to_email, from_email, subject, html, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [userId, to_email, fromEmailResolved, subject, finalHtml]
    )

    const messageId = msgRows[0]?.id
    if (!messageId) {
      return res.status(500).json({ error: 'Failed to create message record' })
    }

    const result = await sendEmail(
      { to: to_email, from: fromEmailResolved, subject, html: finalHtml },
      userId
    )

    if (!result.success) {
      await db.query("UPDATE messages SET status = 'failed' WHERE id = $1", [messageId])
      await db.query(
        'INSERT INTO logs (message_id, status, error, provider) VALUES ($1, $2, $3, $4)',
        [messageId, 'failed', result.error, provider]
      )
      return res.status(500).json({ error: result.error || 'Email send failed' })
    }

    const sesMessageId = result.messageId?.replace(/^<|>$/g, '') ?? null
    await db.query(
      "UPDATE messages SET status = 'sent', ses_message_id = $1 WHERE id = $2",
      [sesMessageId, messageId]
    )

    incrementEmailCounter(userId, 1).catch(() => {})

    await db.query(
      'INSERT INTO logs (message_id, status, provider) VALUES ($1, $2, $3)',
      [messageId, 'sent', provider]
    )

    return res.json({ success: true, messageId })
  } catch (err) {
    console.error('[dashboard/send-email] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
