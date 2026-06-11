import { Router, Request, Response } from 'express'
import { stripe, PLANS } from '../lib/stripe'
import { db } from '../lib/db'
import { authSupabaseUser, UserRequest } from '../middleware/authSupabaseUser'

const router = Router()

interface StripeCheckoutSession {
  metadata?: { plan?: string }
  customer: string
}

interface StripeSubscription {
  customer: string
  status: string
  cancel_at_period_end: boolean
  items: { data: { price: { id: string } }[] }
}

async function syncPlan(customerId: string, plan: string, reason: string) {
  const result = await db.query(
    'UPDATE profiles SET plan = $1, stripe_customer_id = $2 WHERE stripe_customer_id = $3',
    [plan, customerId, customerId]
  )

  if (result.rowCount && result.rowCount > 0) {
    console.log(`[webhook] plan → ${plan} (${reason}) — updated ${result.rowCount} row(s)`)
    return
  }

  console.warn(`[webhook] 0 rows matched for customer ${customerId} — trying Stripe metadata fallback`)

  try {
    const customer = await stripe.customers.retrieve(customerId)
    if (customer.deleted) {
      console.error(`[webhook] Customer ${customerId} is deleted in Stripe — cannot sync`)
      return
    }

    const userId = customer.metadata?.userId
    if (!userId) {
      console.error(`[webhook] Customer ${customerId} has no userId in metadata — cannot sync`)
      return
    }

    const fallback = await db.query(
      'UPDATE profiles SET plan = $1, stripe_customer_id = $2 WHERE id = $3',
      [plan, customerId, userId]
    )

    if (fallback.rowCount && fallback.rowCount > 0) {
      console.log(`[webhook] plan → ${plan} via metadata fallback (${reason}) — updated ${fallback.rowCount} row(s)`)
    } else {
      console.error(`[webhook] Fallback also matched 0 rows for userId ${userId}`)
    }
  } catch (stripeErr: unknown) {
    const message = stripeErr instanceof Error ? stripeErr.message : 'Unknown error'
    console.error(`[webhook] Stripe customer retrieval failed:`, message)
  }
}

router.post('/create-checkout', authSupabaseUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!
    const { userEmail, plan } = req.body

    if (!userEmail || !plan) {
      return res.status(400).json({ error: 'Missing required fields: userEmail, plan' })
    }

    if (!PLANS[plan as keyof typeof PLANS]?.priceId) {
      return res.status(400).json({ error: 'Invalid plan or plan not available for purchase' })
    }

    const { rows } = await db.query(
      'SELECT stripe_customer_id FROM profiles WHERE id = $1',
      [userId]
    )
    let stripeCustomerId = rows[0]?.stripe_customer_id

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({ email: userEmail, metadata: { userId } })
      stripeCustomerId = customer.id
      await db.query(
        'UPDATE profiles SET stripe_customer_id = $1 WHERE id = $2',
        [stripeCustomerId, userId]
      )
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: PLANS[plan as keyof typeof PLANS].priceId!, quantity: 1 }],
      customer: stripeCustomerId,
      success_url: `${process.env.FRONTEND_URL}/dashboard/settings?tab=billing&success=true`,
      cancel_url:  `${process.env.FRONTEND_URL}/dashboard/settings?tab=billing`,
      metadata: { userId, plan },
    })

    return res.json({ url: session.url })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Stripe checkout error:', message)
    return res.status(500).json({ error: message })
  }
})

router.post('/create-portal', authSupabaseUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!

    const { rows } = await db.query(
      'SELECT stripe_customer_id FROM profiles WHERE id = $1',
      [userId]
    )

    if (!rows[0]?.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   rows[0].stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/dashboard/settings?tab=billing`,
    })

    return res.json({ url: session.url })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Stripe portal error:', message)
    return res.status(500).json({ error: message })
  }
})

router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string

  if (!sig) {
    return res.status(400).json({ error: 'Missing stripe-signature header' })
  }

  let event: ReturnType<typeof stripe.webhooks.constructEvent>

  try {
    event = stripe.webhooks.constructEvent(
      req.body as Buffer,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[webhook] Signature verification failed:', message)
    return res.status(400).json({ error: `Webhook Error: ${message}` })
  }

  console.log(`[webhook] Event received: ${event.type}`)
  res.json({ received: true })

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as StripeCheckoutSession
        const plan = session.metadata?.plan
        const customerId = session.customer
        if (plan && customerId) {
          await syncPlan(customerId, plan, 'checkout completed')
        }
        break
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as StripeSubscription
        const { customer: customerId, status, cancel_at_period_end: cancelAtPeriodEnd } = subscription
        if (!customerId) break

        if (status === 'canceled' || cancelAtPeriodEnd) {
          await syncPlan(customerId, 'free', `subscription.updated status=${status} cancel_at_period_end=${cancelAtPeriodEnd}`)
        } else if (status === 'active') {
          const priceId = subscription.items.data[0]?.price?.id
          if (priceId) {
            const planEntry = Object.entries(PLANS).find(([, config]) => config.priceId === priceId)
            if (planEntry) {
              await syncPlan(customerId, planEntry[0], 'subscription.updated active')
            } else {
              console.warn(`[webhook] No matching plan for priceId: ${priceId}`)
            }
          }
        }
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as StripeSubscription
        if (subscription.customer) {
          await syncPlan(subscription.customer, 'free', 'subscription.deleted')
        }
        break
      }

      default:
        console.log(`[webhook] Unhandled event type: ${event.type}`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[webhook] Unexpected handler error:', message)
  }
})

router.get('/status', authSupabaseUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!

    const { rows } = await db.query(
      'SELECT plan, stripe_customer_id FROM profiles WHERE id = $1',
      [userId]
    )
    const profile = rows[0]
    let plan: string = profile?.plan || 'free'

    if (plan !== 'free' && profile?.stripe_customer_id) {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: profile.stripe_customer_id,
          status:   'active',
          limit:    10,
        })

        const trullyActive = subscriptions.data.filter(s => !s.cancel_at_period_end)

        if (trullyActive.length === 0) {
          console.log(`[billing/status] No active subscription for ${userId} — downgrading to free`)
          await db.query('UPDATE profiles SET plan = $1 WHERE id = $2', ['free', userId])
          plan = 'free'
        }
      } catch (stripeErr: unknown) {
        const message = stripeErr instanceof Error ? stripeErr.message : 'Unknown error'
        console.error('[billing/status] Stripe check failed, using DB value:', message)
      }
    }

    return res.json({
      plan,
      hasStripeCustomer: !!profile?.stripe_customer_id,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Stripe status error:', message)
    return res.status(500).json({ error: message })
  }
})

export default router
