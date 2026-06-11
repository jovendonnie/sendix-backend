import { Router, Request, Response } from 'express'
import https from 'https'
import crypto from 'crypto'
import { handleBounce, handleComplaint, handleDelivery } from '../services/bounce.service'
import { supabaseAdmin } from '../lib/supabaseAdmin'

const router = Router()

// In-memory cert cache — bounded to 20 URLs with a 1-hour TTL to prevent unbounded growth
const CERT_CACHE_TTL = 60 * 60 * 1000
const CERT_CACHE_MAX = 20
interface CachedCert { pem: string; expiresAt: number }
const certCache = new Map<string, CachedCert>()

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function verifySNSSignature(payload: Record<string, string>): Promise<boolean> {
  try {
    const certUrl = payload.SigningCertURL
    if (!certUrl) {
      console.warn('[sns] Missing SigningCertURL')
      return false
    }
    // Security: only allow certificates hosted on amazonaws.com
    if (!certUrl.match(/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//)) {
      console.warn('[sns] Rejected cert URL (not amazonaws.com):', certUrl)
      return false
    }

    const now = Date.now()
    const cached = certCache.get(certUrl)
    let cert: string
    if (cached && cached.expiresAt > now) {
      cert = cached.pem
    } else {
      cert = await fetchUrl(certUrl)
      if (certCache.size >= CERT_CACHE_MAX) certCache.clear()
      certCache.set(certUrl, { pem: cert, expiresAt: now + CERT_CACHE_TTL })
    }

    // Field order is fixed and differs by message type (per AWS docs)
    const fields =
      payload.Type === 'Notification'
        ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
        : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']

    let toVerify = ''
    for (const field of fields) {
      if (payload[field] !== undefined) {
        toVerify += `${field}\n${payload[field]}\n`
      }
    }

    // Node.js crypto.verify: synchronous call with PEM cert (extracts public key automatically)
    const signature = Buffer.from(payload.Signature, 'base64')
    const verified = crypto.verify(
      'sha1WithRSAEncryption',
      Buffer.from(toVerify, 'utf8'),
      { key: cert, format: 'pem' },
      signature
    )
    console.log('[sns] Signature verification result:', verified)
    return verified
  } catch (err) {
    console.error('[sns] Signature verification error:', err)
    return false
  }
}

// POST /api/webhooks/ses  — public endpoint, no authApiKey
router.post('/', async (req: Request, res: Response) => {
  try {
    // SNS sends JSON with Content-Type: text/plain — parse manually
    let payload: Record<string, string>
    try {
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      payload = JSON.parse(raw)
    } catch (parseErr) {
      console.error('[sns] Failed to parse body. Content-Type:', req.headers['content-type'])
      console.error('[sns] Raw body preview:', String(req.body).slice(0, 200))
      return res.status(200).json({ ok: true }) // respond 200 so SNS doesn't retry a malformed msg
    }

    console.log('[sns] Received message type:', payload.Type, '| MessageId:', payload.MessageId)

    // Validate signature
    const valid = await verifySNSSignature(payload)
    if (!valid) {
      console.warn('[sns] Invalid signature — ignoring message')
      // Still respond 200: a 4xx would cause SNS to retry indefinitely
      return res.status(200).json({ ok: true })
    }

    // Handle subscription confirmation
    if (payload.Type === 'SubscriptionConfirmation') {
      console.log('[sns] Confirming subscription...')
      await fetchUrl(payload.SubscribeURL)
      console.log('[sns] Subscription confirmed')
      return res.status(200).json({ ok: true })
    }

    if (payload.Type !== 'Notification') {
      return res.status(200).json({ ok: true })
    }

    const snsMessageId = payload.MessageId

    // Deduplication: check if we've already processed this SNS message
    const { data: existing } = await supabaseAdmin
      .from('bounce_events')
      .select('id')
      .eq('sns_message_id', snsMessageId)
      .maybeSingle()

    if (existing) {
      console.log(`[sns] Duplicate message ${snsMessageId} — skipping`)
      return res.status(200).json({ ok: true })
    }

    let sesEvent: Record<string, unknown>
    try {
      sesEvent = JSON.parse(payload.Message)
    } catch {
      console.error('[sns] Failed to parse Message JSON')
      return res.status(200).json({ ok: true })
    }

    const notificationType = sesEvent.notificationType as string
    const mail = (sesEvent.mail ?? {}) as { messageId?: string; destination?: string[] }

    if (notificationType === 'Bounce') {
      await handleBounce(
        sesEvent.bounce as Parameters<typeof handleBounce>[0],
        mail,
        snsMessageId,
        sesEvent
      )
    } else if (notificationType === 'Complaint') {
      await handleComplaint(
        sesEvent.complaint as Parameters<typeof handleComplaint>[0],
        mail,
        snsMessageId,
        sesEvent
      )
    } else if (notificationType === 'Delivery') {
      await handleDelivery(mail)
    }

    return res.status(200).json({ ok: true })

  } catch (err) {
    // Always respond 200 to SNS to prevent infinite retries
    console.error('[sns] Internal error processing webhook:', err)
    return res.status(200).json({ ok: true })
  }
})

export default router
