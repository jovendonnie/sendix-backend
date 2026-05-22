import nodemailer, { Transporter } from 'nodemailer'

let _transporter: Transporter | null = null

/**
 * Returns the singleton SMTP transporter.
 * The pool is created once and reused across requests.
 * Throws at call time (not at import time) so missing env vars surface as
 * runtime errors with a clear message rather than silent undefined behaviour.
 */
export function getSmtpTransporter(): Transporter {
  if (_transporter) return _transporter

  const host = process.env.SMTP_HOST
  const port = parseInt(process.env.SMTP_PORT ?? '587', 10)
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const secure = process.env.SMTP_SECURE === 'true' // true = port 465 implicit TLS

  if (!host || !user || !pass) {
    throw new Error(
      'SMTP not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in the backend .env file.'
    )
  }

  _transporter = nodemailer.createTransport({
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
      // Accept self-signed certs in dev; in prod, your SMTP relay's cert will be valid
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    },
  })

  return _transporter
}

/** Call this if you need to force-reset the singleton (e.g. during tests). */
export function resetSmtpTransporter(): void {
  if (_transporter) {
    (_transporter as Transporter & { close?: () => void }).close?.()
    _transporter = null
  }
}
