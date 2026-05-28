import crypto from 'crypto'
import { supabaseAdmin } from '../lib/supabaseAdmin'

const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'http://localhost:3001'

export async function generateUnsubscribeToken(
  email: string,
  userId: string,
  campaignId?: string
): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex')

  await supabaseAdmin.from('unsubscribe_tokens').insert({
    token,
    email: email.toLowerCase().trim(),
    user_id: userId,
    campaign_id: campaignId ?? null,
    expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  })

  return token
}

export function buildUnsubscribeUrl(token: string): string {
  return `${PUBLIC_API_URL}/unsubscribe?token=${token}`
}

export function injectUnsubscribeFooter(html: string, unsubscribeUrl: string): string {
  const footer = `
<div style="text-align:center;margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;font-family:sans-serif;">
  Si no deseas recibir más correos de este remitente,
  <a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline;">
    haz clic aquí para darte de baja
  </a>
</div>`
  return html + footer
}

export interface UnsubscribeResult {
  ok: boolean
  status: 'unsubscribed' | 'already_unsubscribed' | 'invalid' | 'expired'
  email?: string
  senderName?: string
}

export async function processUnsubscribe(token: string): Promise<UnsubscribeResult> {
  const { data: tokenRow } = await supabaseAdmin
    .from('unsubscribe_tokens')
    .select('id, email, user_id, expires_at, used_at')
    .eq('token', token)
    .maybeSingle()

  if (!tokenRow) return { ok: false, status: 'invalid' }

  if (new Date(tokenRow.expires_at) < new Date()) {
    return { ok: false, status: 'expired' }
  }

  if (tokenRow.used_at) {
    return { ok: true, status: 'already_unsubscribed', email: tokenRow.email }
  }

  await supabaseAdmin
    .from('unsubscribe_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('id', tokenRow.id)

  try {
    await supabaseAdmin.from('suppression_list').insert({
      email: tokenRow.email,
      user_id: tokenRow.user_id,
      reason: 'unsubscribed',
    })
  } catch {
    // Already suppressed for this user, ignore
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('full_name, email')
    .eq('id', tokenRow.user_id)
    .maybeSingle()

  const senderName = profile?.full_name || profile?.email || 'este remitente'

  return { ok: true, status: 'unsubscribed', email: tokenRow.email, senderName }
}

export function renderUnsubscribePage(result: UnsubscribeResult): string {
  const messages: Record<UnsubscribeResult['status'], { title: string; body: string }> = {
    unsubscribed: {
      title: 'Te has dado de baja correctamente',
      body: `No recibirás más correos de ${result.senderName ?? 'este remitente'}.`,
    },
    already_unsubscribed: {
      title: 'Ya estás dado de baja',
      body: 'Tu dirección ya fue removida de esta lista de envíos.',
    },
    invalid: {
      title: 'Link inválido',
      body: 'Este link de baja no es válido o ya fue eliminado.',
    },
    expired: {
      title: 'Link expirado',
      body: 'Este link de baja ya expiró. Contacta al remitente si deseas darte de baja.',
    },
  }

  const { title, body } = messages[result.status]

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} · SendIX</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#fff;border-radius:12px;padding:48px 40px;max-width:480px;width:100%;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06)}
    .logo{display:inline-flex;align-items:center;gap:8px;margin-bottom:32px;text-decoration:none}
    .logo-icon{width:32px;height:32px;background:#6366f1;border-radius:8px;display:flex;align-items:center;justify-content:center}
    .logo-icon svg{width:18px;height:18px;fill:#fff}
    .logo-name{font-size:18px;font-weight:700;color:#111827}
    h1{font-size:22px;font-weight:700;color:#111827;margin-bottom:12px}
    p{font-size:15px;color:#6b7280;line-height:1.6}
  </style>
</head>
<body>
  <div class="card">
    <a class="logo" href="https://sendix.com">
      <div class="logo-icon">
        <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      </div>
      <span class="logo-name">SendIX</span>
    </a>
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`
}
