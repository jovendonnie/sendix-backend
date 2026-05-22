import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export interface SendEmailParams {
  to: string
  subject: string
  text?: string
  html?: string
  from?: string
}

export interface SendEmailResult {
  success: boolean
  data?: object
  statusCode?: number
  error?: string
}

const DEFAULT_FROM = process.env.EMAIL_FROM || 'SendIX <onboarding@resend.dev>'

export async function sendEmail({
  to,
  subject,
  text,
  html,
  from
}: SendEmailParams): Promise<SendEmailResult> {
  try {
    const fromEmail = from || DEFAULT_FROM

    const payload = {
      from: fromEmail,
      to,
      subject,
      ...(html ? { html } : { text: text || '' })
    }

    const result = await resend.emails.send(payload as never)

    if ('error' in result && result.error) {
      const err = result.error as { message: string; statusCode?: number }
      return {
        success: false,
        error: err.message,
        statusCode: err.statusCode,
        data: result
      }
    }

    return { success: true, data: result as object }
  } catch (error) {
    const err = error as { statusCode?: number; message?: string }
    return {
      success: false,
      error: err.message || 'Failed to send email',
      statusCode: err.statusCode
    }
  }
}