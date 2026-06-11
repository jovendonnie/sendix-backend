import { db } from '../lib/db'
import { getActiveProviders, ProviderName } from './provider.service'
import type { EmailPayload, EmailSendResult } from './smtp-email.service'
import { sendEmailViaResend } from './resend-email.service'
import { sendEmailViaSmtp } from './smtp-email.service'

export interface OrchestratorResult extends EmailSendResult {
  provider_used?: string
  retry_count?: number
  fallback_used?: boolean
}

const MAX_RETRIES = 2
const BASE_DELAY_MS = 500

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function sendViaProvider(
  providerName: ProviderName,
  apiKey: string,
  payload: EmailPayload,
  userId: string
): Promise<EmailSendResult> {
  switch (providerName) {
    case 'resend': {
      return await sendEmailViaResend(payload, apiKey)
    }

    case 'ses':
    case 'brevo': {
      // Brevo supports SMTP — reuse nodemailer adapter
      return await sendEmailViaSmtp(payload, userId)
    }

    case 'mailgun': {
      const [mgKey, mgDomain] = apiKey.split('|')
      if (!mgKey || !mgDomain) return { success: false, error: 'Mailgun key format: apiKey|domain' }
      const to = Array.isArray(payload.to) ? payload.to.join(',') : payload.to
      const formData = new URLSearchParams({
        from: payload.from || `SendIX <noreply@${mgDomain}>`,
        to,
        subject: payload.subject,
        ...(payload.html ? { html: payload.html } : { text: payload.text || '' }),
      })
      const base64 = Buffer.from(`api:${mgKey}`).toString('base64')
      const res = await fetch(`https://api.mailgun.net/v3/${mgDomain}/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${base64}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      })
      if (!res.ok) {
        const err = await res.text()
        return { success: false, error: `Mailgun error ${res.status}: ${err}` }
      }
      const json = await res.json() as { id?: string }
      return { success: true, messageId: json.id }
    }

    case 'postmark': {
      const to = Array.isArray(payload.to) ? payload.to[0] : payload.to
      const body = {
        From: payload.from || 'SendIX <noreply@sendix.dev>',
        To: to,
        Subject: payload.subject,
        ...(payload.html ? { HtmlBody: payload.html } : { TextBody: payload.text || '' }),
      }
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.text()
        return { success: false, error: `Postmark error ${res.status}: ${err}` }
      }
      const json = await res.json() as { MessageID?: string }
      return { success: true, messageId: json.MessageID }
    }

    default:
      return { success: false, error: `Unknown provider: ${providerName}` }
  }
}

export async function orchestrateEmail(
  payload: EmailPayload,
  userId: string
): Promise<OrchestratorResult> {
  const providers = await getActiveProviders(userId)

  if (providers.length === 0) {
    return { success: false, error: 'No active providers configured. Connect a provider at /dashboard/providers.' }
  }

  let totalRetries = 0
  let fallbackUsed = false

  for (let pi = 0; pi < providers.length; pi++) {
    const prov = providers[pi]
    if (prov.is_fallback && pi === 0) fallbackUsed = true
    if (prov.is_fallback && pi > 0) fallbackUsed = true

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1))
        totalRetries++
      }

      try {
        const result = await sendViaProvider(
          prov.provider_name as ProviderName,
          prov.decrypted_key,
          payload,
          userId
        )

        if (result.success) {
          return {
            ...result,
            provider_used: prov.provider_name,
            retry_count: totalRetries,
            fallback_used: fallbackUsed,
          }
        }

        console.warn(`[orchestrator] Provider ${prov.provider_name} attempt ${attempt + 1} failed: ${result.error}`)
      } catch (err: any) {
        console.warn(`[orchestrator] Provider ${prov.provider_name} attempt ${attempt + 1} threw: ${err.message}`)
        if (attempt === MAX_RETRIES) break
      }
    }

    if (pi < providers.length - 1) {
      console.log(`[orchestrator] Failing over from ${prov.provider_name} to ${providers[pi + 1].provider_name}`)
    }
  }

  return {
    success: false,
    error: 'All providers failed after retries.',
    retry_count: totalRetries,
    fallback_used: fallbackUsed,
  }
}

export async function updateMessageOrchestration(
  messageId: string,
  result: OrchestratorResult,
  providerMessageId?: string
) {
  await db.query(
    `UPDATE messages
     SET status = $1, final_status = $2, provider_used = $3, retry_count = $4,
         provider_message_id = $5, ses_message_id = $5
     WHERE id = $6`,
    [
      result.success ? 'sent' : 'failed',
      result.success ? 'success' : (result.fallback_used ? 'fallback_used' : 'failed'),
      result.provider_used ?? null,
      result.retry_count ?? 0,
      providerMessageId ?? result.messageId ?? null,
      messageId,
    ]
  )
}
