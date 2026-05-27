import { getSmtpTransporter } from '../lib/smtp'
import { supabaseAdmin } from '../lib/supabaseAdmin'

// ─── Shared interfaces ────────────────────────────────────────────────────────

export interface EmailPayload {
  to: string | string[]
  from?: string
  subject: string
  html?: string
  text?: string
  replyTo?: string
  attachments?: Array<{
    filename: string
    content: string | Buffer
    contentType?: string
  }>
}

export interface EmailSendResult {
  success: boolean
  messageId?: string
  error?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FREE_FROM_EMAIL = process.env.AWS_SES_FROM_EMAIL || 'notificaciones@mail-sendix.com'
const FREE_FROM_NAME  = process.env.SMTP_FROM_NAME      || 'SendIX'

// ─── Identity resolver ───────────────────────────────────────────────────────

/**
 * Look up the first SES-verified domain for the user.
 * Returns null if the user is on the Free plan (no verified domain).
 */
async function getVerifiedDomain(userId: string): Promise<{ id: string; domain: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('domains')
    .select('id, domain')
    .eq('user_id', userId)
    .eq('ses_verification_status', 'verified')
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  return data
}

// ─── Retry helper ────────────────────────────────────────────────────────────

const MAX_RETRIES   = 2
const RETRY_DELAY_MS = 500

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (retries <= 1) throw err
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    return withRetry(fn, retries - 1)
  }
}

// ─── Public send function ────────────────────────────────────────────────────

/**
 * Dispatcher that routes each send to the correct identity:
 *
 *  Free  → from = SendIX shared domain, replyTo = client's original from
 *  Pro   → from = payload.from (must match verified domain), SES signs via Easy DKIM
 *
 * @param payload  Email payload from the route handler
 * @param userId   Supabase user ID (used to look up verified domains). Optional for internal use.
 */
export async function sendEmailViaSmtp(
  payload: EmailPayload,
  userId?: string
): Promise<EmailSendResult> {
  const { to, from, subject, html, text, attachments } = payload

  try {
    let resolvedFrom: string
    let resolvedReplyTo: string | undefined = payload.replyTo
    let cacheKey = 'shared'

    if (userId) {
      const verifiedDomain = await getVerifiedDomain(userId)

      if (verifiedDomain) {
        // ── Pro / Agency ──────────────────────────────────────────────────────
        // The From: must belong to the verified domain; SES handles DKIM signing.
        if (from) {
          // Extract domain portion (handles "Name <user@domain.com>" and "user@domain.com")
          const match = from.match(/@([\w.-]+)/)
          const fromDomain = match ? match[1].toLowerCase() : null

          if (!fromDomain || fromDomain !== verifiedDomain.domain) {
            return {
              success: false,
              error: `El remitente '${from}' no pertenece a tu dominio verificado (${verifiedDomain.domain})`
            }
          }
          resolvedFrom = from
        } else {
          resolvedFrom = `${FREE_FROM_NAME} <noreply@${verifiedDomain.domain}>`
        }
        cacheKey = verifiedDomain.domain

      } else {
        // ── Free plan ─────────────────────────────────────────────────────────
        // Override From: with SendIX shared domain.
        // Move the client's original from to Reply-To so replies go to the client.
        resolvedFrom    = `${FREE_FROM_NAME} <${FREE_FROM_EMAIL}>`
        resolvedReplyTo = from || resolvedReplyTo
        cacheKey        = 'shared'
      }
    } else {
      // No userId (internal / transactional): use free sender as-is
      resolvedFrom = from || `${FREE_FROM_NAME} <${FREE_FROM_EMAIL}>`
    }

    const transporter = getSmtpTransporter(cacheKey)

    const info = await withRetry(() =>
      transporter.sendMail({
        from:    resolvedFrom,
        to:      Array.isArray(to) ? to.join(', ') : to,
        subject,
        html:    html    || undefined,
        text:    text    || undefined,
        replyTo: resolvedReplyTo,
        attachments: attachments?.map(a => ({
          filename:    a.filename,
          content:     a.content,
          contentType: a.contentType,
        })),
      })
    )

    console.log(`[smtp] Sent — messageId: ${info.messageId} | from: ${resolvedFrom}`)
    return { success: true, messageId: info.messageId }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown SMTP error'
    console.error('[smtp] Send failed:', message)
    return { success: false, error: message }
  }
}

/** Verify SMTP connection — use on startup or health-check endpoint. */
export async function verifySmtpConnection(): Promise<boolean> {
  try {
    const transporter = getSmtpTransporter('shared')
    await transporter.verify()
    console.log('[smtp] Connection verified')
    return true
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[smtp] Connection verification failed:', message)
    return false
  }
}
