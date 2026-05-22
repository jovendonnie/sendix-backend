import { getSmtpTransporter } from '../lib/smtp'

// ─── Shared interface (also used by resend-email.service.ts) ──────────────────

export interface EmailPayload {
  to: string | string[]
  from?: string
  subject: string
  html?: string
  text?: string
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

// ─── DKIM config (optional — only when private key is set) ───────────────────

function buildDkimConfig() {
  const privateKey = process.env.SMTP_DKIM_PRIVATE_KEY
  const domainName = process.env.SMTP_DKIM_DOMAIN
  const keySelector = process.env.SMTP_DKIM_SELECTOR ?? 'sendix'

  if (!privateKey || !domainName) return undefined

  // The private key in env vars often has literal \n — convert to real newlines
  const normalizedKey = privateKey.replace(/\\n/g, '\n')

  return {
    domainName,
    keySelector,
    privateKey: normalizedKey,
  }
}

// ─── Default sender ───────────────────────────────────────────────────────────

function defaultFrom(): string {
  const domain = process.env.SMTP_FROM_DOMAIN ?? 'sendix.com'
  const name = process.env.SMTP_FROM_NAME ?? 'SendIX'
  return `${name} <noreply@${domain}>`
}

// ─── Send with automatic retry ───────────────────────────────────────────────

const MAX_RETRIES = 3
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

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendEmailViaSmtp(payload: EmailPayload): Promise<EmailSendResult> {
  const { to, from, subject, html, text, attachments } = payload

  try {
    const transporter = getSmtpTransporter()
    const dkim = buildDkimConfig()

    const info = await withRetry(() =>
      transporter.sendMail({
        from: from || defaultFrom(),
        to: Array.isArray(to) ? to.join(', ') : to,
        subject,
        html: html || undefined,
        text: text || undefined,
        attachments: attachments?.map(a => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
        ...(dkim ? { dkim } : {}),
      })
    )

    console.log(`[smtp] Sent — messageId: ${info.messageId}`)
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
    const transporter = getSmtpTransporter()
    await transporter.verify()
    console.log('[smtp] Connection verified')
    return true
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[smtp] Connection verification failed:', message)
    return false
  }
}
