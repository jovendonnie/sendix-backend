import { Resend } from 'resend'
import type { EmailPayload, EmailSendResult } from './smtp-email.service'

const DEFAULT_FROM = process.env.EMAIL_FROM || 'SendIX <onboarding@resend.dev>'

export async function sendEmailViaResend(payload: EmailPayload, apiKey?: string): Promise<EmailSendResult> {
  const key = apiKey || process.env.RESEND_API_KEY
  if (!key) return { success: false, error: 'No Resend API key configured' }

  const resend = new Resend(key)
  const { to, from, subject, html, text } = payload

  try {
    const result = await resend.emails.send({
      from: from || DEFAULT_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      ...(html ? { html } : { text: text || '' }),
    } as Parameters<typeof resend.emails.send>[0])

    if ('error' in result && result.error) {
      const err = result.error as { message: string }
      console.error('[resend] Send failed:', err.message)
      return { success: false, error: err.message }
    }

    const data = result as { data?: { id?: string } }
    const messageId = data.data?.id
    console.log(`[resend] Sent — messageId: ${messageId ?? 'unknown'}`)
    return { success: true, messageId }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown Resend error'
    console.error('[resend] Send failed:', message)
    return { success: false, error: message }
  }
}
