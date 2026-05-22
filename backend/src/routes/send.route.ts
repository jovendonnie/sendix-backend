import { Router, Response } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { authApiKey, AuthenticatedRequest } from '../middleware/authApiKey'
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
  console.log('Applied variables, final HTML:', result.substring(0, 100))
  return result
}

router.post('/', authApiKey, async (req: AuthenticatedRequest, res: Response) => {
  let message: { id: string } | null = null

  try {
    const apiKey = req.apiKey

    if (!apiKey) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const { to_email, subject, html, variables, from_email } = req.body

    console.log('API KEY USER ID:', apiKey.user_id)
    console.log('VARIABLES:', variables)

    if (!to_email || !subject || !html) {
      return res.status(400).json({
        error: 'Missing required fields',
      })
    }

    // 1. INSERT MESSAGE (ANTES de enviar)
    const { data: msgData, error: insertError } = await supabaseAdmin
      .from('messages')
      .insert({
        user_id: apiKey.user_id,
        api_key_id: apiKey.id,
        to_email: to_email,
        from_email: from_email || 'onboarding@resend.dev',
        subject,
        html,
        status: 'pending',
      })
      .select()
      .single()

    if (insertError) {
      console.error('INSERT ERROR:', insertError)
      return res.status(500).json({
        error: 'Failed to create message',
      })
    }

    if (!msgData) {
      return res.status(500).json({
        error: 'Failed to create message',
      })
    }

    message = msgData as { id: string }
    console.log('MESSAGE CREATED:', message.id)

    // Apply variables to HTML
    const finalHtml = applyVariables(html, variables)

    // 2. SEND EMAIL
    const result = await sendEmail({
      to: to_email,
      from: from_email || undefined,
      subject,
      html: finalHtml,
    })

    console.log('SEND RESPONSE:', result)

    if (!result.success) {
      throw new Error(result.error ?? 'Email send failed')
    }

    console.log('EMAIL SENT:', result.messageId)

    // 3. UPDATE MESSAGE → sent
    await supabaseAdmin
      .from('messages')
      .update({ status: 'sent' })
      .eq('id', message.id)

    // 4. INSERT LOG
    const provider = (process.env.EMAIL_PROVIDER ?? 'resend').toLowerCase()
    const { error: logError } = await supabaseAdmin
      .from('logs')
      .insert({
        message_id: message.id,
        status: 'sent',
        provider,
      })

    if (logError) {
      console.error('LOG INSERT ERROR:', logError)
    } else {
      console.log('LOG INSERTED SUCCESSFULLY')
    }

    return res.json({
      success: true,
      messageId: message.id,
    })

  } catch (err: unknown) {
    const catchError = err as { message?: string }
    console.error('UNEXPECTED ERROR:', catchError)

    // 5. UPDATE MESSAGE → failed (if message was created)
    if (message?.id) {
      await supabaseAdmin
        .from('messages')
        .update({ status: 'failed' })
        .eq('id', message.id)

      // 6. INSERT FAIL LOG
      const { error: failLogError } = await supabaseAdmin
        .from('logs')
        .insert({
          message_id: message.id,
          status: 'failed',
          error: catchError.message,
        })

      if (failLogError) {
        console.error('FAIL LOG INSERT ERROR:', failLogError)
      }
    }

    return res.status(500).json({
      error: 'Internal server error',
    })
  }
})

// Bulk send endpoint
router.post('/bulk', authApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const { rows, subject, from_email, template } = req.body

    if (!rows || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'rows array required' })
    }

    if (!template) {
      return res.status(400).json({ error: 'template required' })
    }

    console.log('Bulk sending to', rows.length, 'recipients')

    const BATCH_SIZE = 5
const DELAY_MS = 1000

    const results = []

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)

      console.log(`Processing batch ${i / BATCH_SIZE + 1}`)

      const batchResults = await Promise.all(
        batch.map(async (row) => {
          try {
            let html = template

            Object.keys(row).forEach((key) => {
              html = html.replace(new RegExp(`{{${key}}}`, 'g'), row[key])
            })

            const response = await sendEmail({
              to: row.email || row.Email || row.mail,
              subject,
              html,
              from: from_email,
            })

            return { success: response.success, error: response.error || null }
          } catch (error: any) {
            return { success: false, error: error.message }
          }
        })
      )

      results.push(...batchResults)

      if (i + BATCH_SIZE < rows.length) {
        await sleep(DELAY_MS)
      }
    }

    res.json({
      success: true,
      total: rows.length,
      sent: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    })
  } catch (err) {
    console.error('Bulk send error:', err)
    res.status(500).json({ error: 'Bulk send failed' })
  }
})

export default router