import { Router, Request, Response } from 'express'
import { ingestWebhookEvent, confirmSnsSubscription } from '../services/webhook-ingest.service'

const router = Router()

/**
 * POST /api/webhooks/ingest/:userId
 *
 * Public endpoint — no auth. Receives events from email providers.
 * The userId in the URL routes the event to the correct account.
 */
router.post('/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const headers = req.headers as Record<string, string | string[] | undefined>
    let body = req.body

    // Handle AWS SNS text/plain body
    if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch { /* keep as-is */ }
    }

    // AWS SNS: confirm subscription before processing events
    if (body?.Type === 'SubscriptionConfirmation' && body?.SubscribeURL) {
      await confirmSnsSubscription(body.SubscribeURL)
      return res.status(200).json({ ok: true })
    }

    // AWS SNS: handle unsubscribe confirmation
    if (body?.Type === 'UnsubscribeConfirmation') {
      return res.status(200).json({ ok: true })
    }

    // Some providers send arrays of events (Brevo, Mailgun)
    const events = Array.isArray(body) ? body : [body]

    const results = await Promise.allSettled(
      events.map(evt => ingestWebhookEvent(userId, headers, evt))
    )

    const saved = results.filter(r => r.status === 'fulfilled' && (r.value as any).saved).length
    const failed = results.length - saved

    return res.status(200).json({ received: results.length, saved, failed })
  } catch (err: any) {
    console.error('[ingest] Unhandled error:', err)
    // Always return 200 to prevent provider retries on our errors
    return res.status(200).json({ ok: false, error: err.message })
  }
})

export default router
