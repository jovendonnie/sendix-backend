import nodemailer, { Transporter } from 'nodemailer'

/**
 * Per-domain cache of Nodemailer transporters.
 *
 * Key strategy:
 *  - 'shared'        → Plan Free / fallback (uses SendIX shared domain)
 *  - 'empresa.com'   → Plan Pro/Agency (key = verified customer domain)
 *
 * With Easy DKIM, all transporters connect to the same SES SMTP endpoint
 * with the same credentials — the difference lives only in the From: header.
 * SES signs automatically when it detects a verified Easy-DKIM domain.
 */
const transporterCache = new Map<string, Transporter>()

export function getSmtpTransporter(domainKey: string = 'shared'): Transporter {
  if (transporterCache.has(domainKey)) {
    return transporterCache.get(domainKey)!
  }

  const host = process.env.AWS_SES_SMTP_HOST || process.env.SMTP_HOST
  const port = parseInt(process.env.AWS_SES_SMTP_PORT || process.env.SMTP_PORT || '465', 10)
  const user = process.env.AWS_SES_SMTP_USER || process.env.SMTP_USER
  const pass = process.env.AWS_SES_SMTP_PASS || process.env.SMTP_PASS
  // port 465 = implicit TLS (secure: true)
  // port 587 = STARTTLS — starts plain then upgrades (secure: false)
  const secure = port === 465

  if (!host || !user || !pass) {
    throw new Error(
      'SMTP not configured. Set AWS_SES_SMTP_HOST, AWS_SES_SMTP_USER and AWS_SES_SMTP_PASS in the backend .env file.'
    )
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    pool: true,          // keep-alive connection pool
    maxConnections: 5,   // max simultaneous SMTP connections
    maxMessages: 100,    // messages per connection before recycling
    rateDelta: 1000,     // rate-limit window (ms)
    rateLimit: 10,       // max messages per rateDelta window
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    },
  })

  transporterCache.set(domainKey, transporter)
  console.log(`[smtp] Transporter created and cached for key: "${domainKey}"`)
  return transporter
}

/**
 * Clear a specific transporter from the cache.
 * Call this when a customer's domain is revoked so the next send
 * doesn't accidentally reuse a stale connection.
 */
export function clearTransporterCache(domainKey: string): void {
  const transporter = transporterCache.get(domainKey)
  if (transporter) {
    ;(transporter as Transporter & { close?: () => void }).close?.()
    transporterCache.delete(domainKey)
    console.log(`[smtp] Cleared transporter cache for: "${domainKey}"`)
  }
}

/**
 * Reset all cached transporters (useful in tests or forced restarts).
 */
export function resetAllTransporters(): void {
  for (const transporter of transporterCache.values()) {
    ;(transporter as Transporter & { close?: () => void }).close?.()
  }
  transporterCache.clear()
  console.log('[smtp] All transporter caches cleared')
}

/** @deprecated Use resetAllTransporters() */
export const resetSmtpTransporter = resetAllTransporters
