import { Router, Request, Response } from 'express'
import { Webhook } from 'svix'
import { db } from '../lib/db'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET
  if (!secret) {
    console.error('[clerk-webhook] CLERK_WEBHOOK_SECRET not set')
    return res.status(500).json({ error: 'Webhook secret not configured' })
  }

  const wh = new Webhook(secret)
  let event: any

  try {
    const body = (req.body as Buffer).toString()
    event = wh.verify(body, {
      'svix-id':        req.headers['svix-id'] as string,
      'svix-timestamp': req.headers['svix-timestamp'] as string,
      'svix-signature': req.headers['svix-signature'] as string,
    })
  } catch (err) {
    console.error('[clerk-webhook] Signature verification failed:', err)
    return res.status(400).json({ error: 'Invalid webhook signature' })
  }

  if (event.type === 'user.created') {
    const { id, email_addresses } = event.data
    const email = email_addresses?.[0]?.email_address ?? null

    try {
      await db.query(
        `INSERT INTO profiles (id, email, plan)
         VALUES ($1, $2, 'free')
         ON CONFLICT (id) DO NOTHING`,
        [id, email]
      )
      console.log(`[clerk-webhook] Profile created for ${id}`)
    } catch (err) {
      console.error('[clerk-webhook] Failed to create profile:', err)
      return res.status(500).json({ error: 'Failed to create profile' })
    }
  }

  return res.json({ ok: true })
})

export default router
