import { Router, Response } from 'express'
import { supabaseAdmin } from '../../lib/supabaseAdmin'
import { authApiKey, AuthenticatedRequest, checkScope } from '../../middleware/authApiKey'
import { checkEmailLimit, incrementEmailCounter } from '../../middleware/checkPlanLimits'
import { sendEmail } from '../../services/email.service'
import { triggerWebhooks } from '../../services/webhook.service'

const DEFAULT_FROM_EMAIL =
  process.env.AWS_SES_FROM_EMAIL || 'onboarding@supportsendix.online'

const router = Router()

/**
 * POST /api/v1/emails
 * Send a single email.
 *
 * @param {AuthenticatedRequest} req - Request with apiKey attached by authApiKey middleware
 * @param {Response} res - Express response
 * @reqBody {
 *   "to": "string or array of emails",
 *   "from": "optional, uses default if not provided",
 *   "subject": "required string",
 *   "html": "optional string",
 *   "text": "optional string",
 *   "variables": {} // optional object for {{variable}} replacement
 * }
 * @response { success: true, data: { messageId: string, status: string } }
 * @response { success: false, error: string, code: string }
 */
router.post('/', authApiKey, checkEmailLimit, async (req: AuthenticatedRequest, res: Response) => {
  let message: { id: string } | null = null
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
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to and subject are required',
        code: 'MISSING_FIELDS'
      })
    }

    toEmails = Array.isArray(to) ? to : [to]

    // Always resolve a fallback so from_email is never null in the DB.
    // The SMTP dispatcher will override this to the shared SendIX domain for Free plans.
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

    const messagePayload: Record<string, unknown> = {
      user_id: apiKey.user_id,
      api_key_id: apiKey.id,
      to_email: toEmails.join(', '),
      from_email: fromEmail,
      subject,
      html: finalHtml,
      status: 'pending',
    }
    if (apiKey.organization_id) {
      messagePayload.organization_id = apiKey.organization_id
    }

    const { data: msgData, error: insertError } = await supabaseAdmin
      .from('messages')
      .insert(messagePayload)
      .select()
      .single()

    if (insertError || !msgData) {
      console.error('INSERT ERROR:', insertError)
      return res.status(500).json({
        success: false,
        error: 'Failed to create message',
        code: 'DB_ERROR'
      })
    }

    message = msgData as { id: string }

    const result = await sendEmail(
      {
        to: toEmails.length === 1 ? toEmails[0] : toEmails,
        from: fromEmail,
        subject,
        html: finalHtml,
      },
      apiKey.user_id  // required for SES identity routing (Free vs Pro)
    )

    if (!result.success) {
      throw new Error(result.error ?? 'Email send failed')
    }

    await supabaseAdmin
      .from('messages')
      .update({ status: 'sent' })
      .eq('id', message.id)

    // Increment monthly counter (non-blocking)
    incrementEmailCounter(apiKey.user_id, 1).catch(() => {/* logged inside */})

    const provider = (process.env.EMAIL_PROVIDER ?? 'resend').toLowerCase()
    await supabaseAdmin
      .from('logs')
      .insert({
        message_id: message.id,
        status: 'sent',
        provider,
      })

    triggerWebhooks(apiKey.user_id, 'email.delivered', {
      messageId: message.id,
      to: toEmails,
      subject,
      timestamp: new Date()
    }).catch(err => console.error('Webhook trigger failed:', err))

    return res.json({
      success: true,
      data: {
        messageId: message.id,
        status: 'sent'
      }
    })

  } catch (err: unknown) {
    const catchError = err as { message?: string }

    if (message?.id) {
      await supabaseAdmin
        .from('messages')
        .update({ status: 'failed' })
        .eq('id', message.id)

      await supabaseAdmin
        .from('logs')
        .insert({
          message_id: message.id,
          status: 'failed',
          error: catchError.message,
        })

      triggerWebhooks(apiKey.user_id, 'email.failed', {
        messageId: message.id,
        to: toEmails,
        subject,
        error: catchError.message,
        timestamp: new Date()
      }).catch(err => console.error('Webhook trigger failed:', err))
    }

    return res.status(500).json({
      success: false,
      error: catchError.message || 'Internal server error',
      code: 'SEND_ERROR'
    })
  }
})

/**
 * POST /api/v1/emails/batch
 * Send bulk emails from an array of email objects.
 *
 * @param {AuthenticatedRequest} req - Request with apiKey attached by authApiKey middleware
 * @param {Response} res - Express response
 * @reqBody {
 *   "emails": [
 *     { "to": "email", "subject": "string", "html": "string", "variables": {} }
 *   ]
 * }
 * @response { success: true, data: { total: number, sent: number, failed: number, results: [] } }
 * @response { success: false, error: string, code: string }
 */
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
    const DELAY_MS = 1000
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
        total: emails.length,
        sent: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results
      }
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Bulk send failed',
      code: 'BULK_SEND_ERROR'
    })
  }
})

/**
 * GET /api/v1/emails
 * List sent emails for the authenticated user with pagination.
 *
 * @param {AuthenticatedRequest} req - Request with apiKey attached by authApiKey middleware
 * @param {Response} res - Express response
 * @queryParams page (default: 1), limit (default: 20)
 * @response { success: true, data: { emails: [], page: number, limit: number, total: number } }
 * @response { success: false, error: string, code: string }
 */
router.get('/', authApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }

    if (!checkScope(req, 'read_only')) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions. Read-only or full-access key required.', code: 'FORBIDDEN' })
    }

    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 20
    const offset = (page - 1) * limit

    const { data: emails, error, count } = await supabaseAdmin
      .from('messages')
      .select('*', { count: 'exact' })
      .eq('user_id', apiKey.user_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch emails',
        code: 'DB_ERROR'
      })
    }

    return res.json({
      success: true,
      data: {
        emails: emails || [],
        page,
        limit,
        total: count || 0
      }
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error',
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * GET /api/v1/emails/:id
 * Get details of a specific email by ID.
 *
 * @param {AuthenticatedRequest} req - Request with apiKey attached by authApiKey middleware
 * @param {Response} res - Express response
 * @param {string} id - Email message ID
 * @response { success: true, data: { email: {} } }
 * @response { success: false, error: string, code: string }
 */
router.get('/:id', authApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }

    if (!checkScope(req, 'read_only')) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions. Read-only or full-access key required.', code: 'FORBIDDEN' })
    }

    const { id } = req.params

    const { data: email, error } = await supabaseAdmin
      .from('messages')
      .select('*')
      .eq('id', id)
      .eq('user_id', apiKey.user_id)
      .single()

    if (error || !email) {
      return res.status(404).json({
        success: false,
        error: 'Email not found',
        code: 'NOT_FOUND'
      })
    }

    return res.json({
      success: true,
      data: { email }
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error',
      code: 'FETCH_ERROR'
    })
  }
})

export default router
