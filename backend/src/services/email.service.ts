import type { EmailPayload, EmailSendResult } from './smtp-email.service'
import { sendEmailViaSmtp } from './smtp-email.service'
import { sendEmailViaResend } from './resend-email.service'

export type { EmailPayload, EmailSendResult }

/**
 * Primary send function used by all routes.
 *
 * Reads EMAIL_PROVIDER from the environment:
 *   ses    → AWS SES via SMTP + Easy DKIM identity dispatcher (production)  ← recommended
 *   smtp   → alias for 'ses' (legacy name, same behavior)
 *   resend → Resend API (fallback / legacy)
 *
 * Default is "resend" so the service works out-of-the-box while SES is being configured.
 *
 * @param payload  Email fields (to, from, subject, html, text…)
 * @param userId   Supabase user ID — required for SES identity routing (Free vs Pro).
 *                 Dispatcher checks if the user has a verified domain; if not → Free sender.
 */
export async function sendEmail(
  payload: EmailPayload,
  userId?: string
): Promise<EmailSendResult> {
  const provider = (process.env.EMAIL_PROVIDER ?? 'resend').toLowerCase()

  // Accept both 'ses' and 'smtp' as "use AWS SES SMTP transporter"
  if (provider === 'ses' || provider === 'smtp') {
    return sendEmailViaSmtp(payload, userId)
  }

  return sendEmailViaResend(payload)
}
