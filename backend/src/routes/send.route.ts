import { Router, Response } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { authApiKey, AuthenticatedRequest } from '../middleware/authApiKey'
import { checkEmailLimit, incrementEmailCounter } from '../middleware/checkPlanLimits'
import { sendEmail } from '../services/email.service'
import { filterSuppressedEmails } from '../services/suppression.service'
import { generateUnsubscribeToken, buildUnsubscribeUrl, injectUnsubscribeFooter } from '../services/unsubscribe.service'

const router = Router()

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

// Apply dynamic variables to HTML
function applyVariables(html: string, vars: Record<string, string>) {
  let result = html
  Object.keys(vars || {}).forEach((key) => {
    const regex = new RegExp(`{{${key}}}`, 'g')
    result = result.replace(regex, vars[key])
  })
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/send
// Single email send
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authApiKey, checkEmailLimit, async (req: AuthenticatedRequest, res: Response) => {
  let message: { id: string } | null = null

  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const userId = apiKey.user_id
    const { to_email, subject, html, variables, from_email } = req.body

    if (!to_email || !subject || !html) {
      return res.status(400).json({ error: 'Missing required fields: to_email, subject, html' })
    }

    // 1. INSERT message (status = pending before send)
    const msgPayload: Record<string, unknown> = {
      user_id:    userId,
      api_key_id: apiKey.id,
      to_email,
      from_email: from_email || process.env.AWS_SES_FROM_EMAIL || 'notificaciones@mail-sendix.com',
      subject,
      html,
      status:     'pending',
    }
    if (apiKey.organization_id) {
      msgPayload.organization_id = apiKey.organization_id
    }

    const { data: msgData, error: insertError } = await supabaseAdmin
      .from('messages')
      .insert(msgPayload)
      .select()
      .single()

    if (insertError || !msgData) {
      console.error('INSERT ERROR:', insertError)
      return res.status(500).json({ error: 'Failed to create message record' })
    }

    message = msgData as { id: string }

    // 2. Apply variables and send
    const finalHtml = applyVariables(html, variables || {})

    const result = await sendEmail(
      { to: to_email, from: from_email || undefined, subject, html: finalHtml },
      userId
    )

    if (!result.success) {
      if (result.suppressed) {
        // Email was suppressed — mark message accordingly and return success (not an error)
        await supabaseAdmin
          .from('messages')
          .update({ status: 'suppressed' })
          .eq('id', message.id)

        const provider = (process.env.EMAIL_PROVIDER ?? 'resend').toLowerCase()
        await supabaseAdmin.from('logs').insert({
          message_id: message.id,
          status:     'suppressed',
          error:      `Suppressed: ${result.suppressedReason}`,
          provider,
        })

        return res.json({ success: true, messageId: message.id, suppressed: true, reason: result.suppressedReason })
      }
      throw new Error(result.error ?? 'Email send failed')
    }

    // 3. Update message → sent + store SES message ID for delivery/bounce tracking
    // nodemailer wraps the ID in angle brackets; strip them so it matches SNS notifications
    const sesMessageId = result.messageId?.replace(/^<|>$/g, '') ?? null
    await supabaseAdmin
      .from('messages')
      .update({ status: 'sent', ses_message_id: sesMessageId })
      .eq('id', message.id)

    // 4. Increment monthly counter (non-blocking — failure doesn't affect response)
    incrementEmailCounter(userId, 1).catch(() => {/* already logged inside */})

    // 5. Insert send log
    const provider = (process.env.EMAIL_PROVIDER ?? 'resend').toLowerCase()
    await supabaseAdmin.from('logs').insert({
      message_id: message.id,
      status:     'sent',
      provider,
    })

    return res.json({ success: true, messageId: message.id })

  } catch (err: unknown) {
    const catchError = err as { message?: string }
    console.error('SEND ERROR:', catchError)

    // Update message → failed
    if (message?.id) {
      await supabaseAdmin
        .from('messages')
        .update({ status: 'failed' })
        .eq('id', message.id)

      await supabaseAdmin.from('logs').insert({
        message_id: message.id,
        status:     'failed',
        error:      catchError.message,
      })
    }

    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/send/bulk
// Bulk email send — one template, many recipients
// ─────────────────────────────────────────────────────────────────────────────
router.post('/bulk', authApiKey, checkEmailLimit, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const userId = apiKey.user_id
    const { rows, subject, from_email, template } = req.body

    if (!rows || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'rows array required' })
    }
    if (!template) {
      return res.status(400).json({ error: 'template required' })
    }

    const BATCH_SIZE = 5
    const DELAY_MS   = 1000
    const results    = []

    // Pre-filter suppressed emails for the entire batch in one query
    const allEmails = rows.map((r: Record<string, string>) => r.email || r.Email || r.mail).filter(Boolean)
    const { suppressed: suppressedEmails } = await filterSuppressedEmails(allEmails, userId)
    const suppressedSet = new Set(suppressedEmails.map(s => s.email.toLowerCase()))

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)

      const batchResults = await Promise.all(
        batch.map(async (row: Record<string, string>) => {
          const recipientEmail = (row.email || row.Email || row.mail || '').toLowerCase()

          if (suppressedSet.has(recipientEmail)) {
            return { success: true, suppressed: true, email: recipientEmail }
          }

          try {
            let html = template
            Object.keys(row).forEach((key) => {
              html = html.replace(new RegExp(`{{${key}}}`, 'g'), row[key])
            })

            // Generate unsubscribe token and inject footer for bulk sends
            let unsubscribeUrl: string | undefined
            try {
              const token = await generateUnsubscribeToken(recipientEmail, userId)
              unsubscribeUrl = buildUnsubscribeUrl(token)
              html = injectUnsubscribeFooter(html, unsubscribeUrl)
            } catch (tokenErr) {
              console.warn('[bulk] Failed to generate unsubscribe token:', tokenErr)
            }

            const response = await sendEmail(
              { to: recipientEmail, subject, html, from: from_email, unsubscribeUrl },
              userId
            )
            return { success: response.success, error: response.error || null }
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            return { success: false, error: message }
          }
        })
      )

      results.push(...batchResults)

      if (i + BATCH_SIZE < rows.length) {
        await sleep(DELAY_MS)
      }
    }

    const sentCount       = results.filter(r => r.success && !r.suppressed).length
    const suppressedCount = results.filter(r => r.suppressed).length

    // Only increment counter for actually sent emails (not suppressed)
    if (sentCount > 0) {
      incrementEmailCounter(userId, sentCount).catch(() => {/* logged inside */})
    }

    return res.json({
      success:    true,
      total:      rows.length,
      sent:       sentCount,
      suppressed: suppressedCount,
      failed:     results.filter(r => !r.success && !r.suppressed).length,
      results,
    })
  } catch (err) {
    console.error('Bulk send error:', err)
    return res.status(500).json({ error: 'Bulk send failed' })
  }
})

export default router
