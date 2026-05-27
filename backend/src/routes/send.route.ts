import { Router, Response } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { authApiKey, AuthenticatedRequest } from '../middleware/authApiKey'
import { checkEmailLimit, incrementEmailCounter } from '../middleware/checkPlanLimits'
import { sendEmail } from '../services/email.service'

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
      throw new Error(result.error ?? 'Email send failed')
    }

    // 3. Update message → sent
    await supabaseAdmin
      .from('messages')
      .update({ status: 'sent' })
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

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)

      const batchResults = await Promise.all(
        batch.map(async (row: Record<string, string>) => {
          try {
            let html = template
            Object.keys(row).forEach((key) => {
              html = html.replace(new RegExp(`{{${key}}}`, 'g'), row[key])
            })

            const response = await sendEmail(
              { to: row.email || row.Email || row.mail, subject, html, from: from_email },
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

    const sentCount = results.filter(r => r.success).length

    // Increment counter by the number of successfully sent emails
    if (sentCount > 0) {
      incrementEmailCounter(userId, sentCount).catch(() => {/* logged inside */})
    }

    return res.json({
      success: true,
      total:   rows.length,
      sent:    sentCount,
      failed:  results.filter(r => !r.success).length,
      results,
    })
  } catch (err) {
    console.error('Bulk send error:', err)
    return res.status(500).json({ error: 'Bulk send failed' })
  }
})

export default router
