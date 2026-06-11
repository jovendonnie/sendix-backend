import { Router, Response } from 'express'
import { db } from '../../lib/db'
import { authApiKey, AuthenticatedRequest, checkScope } from '../../middleware/authApiKey'
import { checkEmailLimit, incrementEmailCounter } from '../../middleware/checkPlanLimits'
import { sendEmail } from '../../services/email.service'
import { triggerWebhooks } from '../../services/webhook.service'

const DEFAULT_FROM_EMAIL =
  process.env.AWS_SES_FROM_EMAIL || 'onboarding@supportsendix.online'

const router = Router()

router.post('/', authApiKey, checkEmailLimit, async (req: AuthenticatedRequest, res: Response) => {
  let messageId: string | null = null
  let apiKey: any = null
  let toEmails: string[] = []
  let subject = ''

  try {
    apiKey = req.apiKey

    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }

    if (!checkScope(req, 'send_only')) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions. Send-only or full-access key required.', code: 'FORBIDDEN' })
    }

    const { to, from, subject: subj, html, text, variables } = req.body
    subject = subj

    if (!to || !subject) {
      return res.status(400).json({ success: false, error: 'Missing required fields: to and subject are required', code: 'MISSING_FIELDS' })
    }

    toEmails = Array.isArray(to) ? to : [to]

    const fromEmail = (from && from.trim()) ? from.trim() : DEFAULT_FROM_EMAIL

    let finalHtml = html || ''
    if (variables && typeof variables === 'object') {
      Object.keys(variables).forEach((key) => {
        const regex = new RegExp(`{{${key}}}`, 'g')
        finalHtml = finalHtml.replace(regex, variables[key])
      })
    }
    if (text && !finalHtml) {
      finalHtml = `<p>${text}</p>`
    }

    const { rows: msgRows } = await db.query(
      `INSERT INTO messages (user_id, api_key_id, to_email, from_email, subject, html, status, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id`,
      [apiKey.user_id, apiKey.id, toEmails.join(', '), fromEmail, subject, finalHtml, apiKey.organization_id ?? null]
    )

    if (!msgRows[0]) {
      return res.status(500).json({ success: false, error: 'Failed to create message', code: 'DB_ERROR' })
    }

    messageId = msgRows[0].id

    const result = await sendEmail(
      { to: toEmails.length === 1 ? toEmails[0] : toEmails, from: fromEmail, subject, html: finalHtml },
      apiKey.user_id
    )

    if (!result.success) {
      throw new Error(result.error ?? 'Email send failed')
    }

    await db.query("UPDATE messages SET status = 'sent' WHERE id = $1", [messageId])

    incrementEmailCounter(apiKey.user_id, 1).catch(() => {})

    const provider = (process.env.EMAIL_PROVIDER ?? 'resend').toLowerCase()
    await db.query(
      'INSERT INTO logs (message_id, status, provider) VALUES ($1, $2, $3)',
      [messageId, 'sent', provider]
    )

    triggerWebhooks(apiKey.user_id, 'email.delivered', {
      messageId,
      to: toEmails,
      subject,
      timestamp: new Date(),
    }).catch(err => console.error('Webhook trigger failed:', err))

    return res.json({ success: true, data: { messageId, status: 'sent' } })

  } catch (err: unknown) {
    const catchError = err as { message?: string }

    if (messageId) {
      await db.query("UPDATE messages SET status = 'failed' WHERE id = $1", [messageId])

      const provider = (process.env.EMAIL_PROVIDER ?? 'resend').toLowerCase()
      await db.query(
        'INSERT INTO logs (message_id, status, error, provider) VALUES ($1, $2, $3, $4)',
        [messageId, 'failed', catchError.message, provider]
      )

      triggerWebhooks(apiKey?.user_id, 'email.failed', {
        messageId,
        to: toEmails,
        subject,
        error: catchError.message,
        timestamp: new Date(),
      }).catch(err => console.error('Webhook trigger failed:', err))
    }

    return res.status(500).json({ success: false, error: catchError.message || 'Internal server error', code: 'SEND_ERROR' })
  }
})

router.post('/batch', authApiKey, checkEmailLimit, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }

    if (!checkScope(req, 'send_only')) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions. Send-only or full-access key required.', code: 'FORBIDDEN' })
    }

    const { emails } = req.body

    if (!emails || !Array.isArray(emails)) {
      return res.status(400).json({ success: false, error: 'emails array required', code: 'MISSING_FIELDS' })
    }

    const BATCH_SIZE = 5
    const DELAY_MS   = 1000
    const results: any[] = []

    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batch = emails.slice(i, i + BATCH_SIZE)

      const batchResults = await Promise.all(
        batch.map(async (email: any) => {
          try {
            const { to, subject, html, from, variables } = email

            if (!to || !subject) {
              return { success: false, error: 'Missing to or subject', email: to }
            }

            let finalHtml = html || ''
            if (variables && typeof variables === 'object') {
              Object.keys(variables).forEach((key) => {
                const regex = new RegExp(`{{${key}}}`, 'g')
                finalHtml = finalHtml.replace(regex, variables[key])
              })
            }

            const result = await sendEmail(
              {
                to,
                from: (from && from.trim()) ? from.trim() : DEFAULT_FROM_EMAIL,
                subject,
                html: finalHtml,
              },
              apiKey.user_id
            )

            return { success: result.success, error: result.error || null, email: to }
          } catch (error: any) {
            return { success: false, error: error.message, email: email.to }
          }
        })
      )

      results.push(...batchResults)

      if (i + BATCH_SIZE < emails.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS))
      }
    }

    return res.json({
      success: true,
      data: {
        total:  emails.length,
        sent:   results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results,
      },
    })
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Bulk send failed', code: 'BULK_SEND_ERROR' })
  }
})

router.get('/', authApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }

    if (!checkScope(req, 'read_only')) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions. Read-only or full-access key required.', code: 'FORBIDDEN' })
    }

    const page   = parseInt(req.query.page as string) || 1
    const limit  = parseInt(req.query.limit as string) || 20
    const offset = (page - 1) * limit

    const { rows: emails } = await db.query(
      'SELECT * FROM messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [apiKey.user_id, limit, offset]
    )

    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) as count FROM messages WHERE user_id = $1',
      [apiKey.user_id]
    )
    const total = parseInt(countRows[0]?.count || '0', 10)

    return res.json({ success: true, data: { emails, page, limit, total } })
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Internal server error', code: 'FETCH_ERROR' })
  }
})

router.get('/:id', authApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }

    if (!checkScope(req, 'read_only')) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions. Read-only or full-access key required.', code: 'FORBIDDEN' })
    }

    const { rows } = await db.query(
      'SELECT * FROM messages WHERE id = $1 AND user_id = $2',
      [req.params.id, apiKey.user_id]
    )

    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Email not found', code: 'NOT_FOUND' })
    }

    return res.json({ success: true, data: { email: rows[0] } })
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Internal server error', code: 'FETCH_ERROR' })
  }
})

export default router
