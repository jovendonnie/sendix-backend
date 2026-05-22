import type { EmailPayload, EmailSendResult } from './smtp-email.service'
import { sendEmailViaSmtp } from './smtp-email.service'
import { sendEmailViaResend } from './resend-email.service'

export type { EmailPayload, EmailSendResult }

/**
 * Primary send function used by all routes.
 *
 * Reads EMAIL_PROVIDER from the environment:
 *   smtp   → own SMTP server (production target)
 *   resend → Resend API (fallback / legacy)
 *
 * Default is "resend" so that the service works out-of-the-box
 * while SMTP credentials are being set up.
 */
export async function sendEmail(payload: EmailPayload): Promise<EmailSendResult> {
  const provider = (process.env.EMAIL_PROVIDER ?? 'resend').toLowerCase()

  if (provider === 'smtp') {
    return sendEmailViaSmtp(payload)
  }

  return sendEmailViaResend(payload)
}
