import { Router, Request, Response } from 'express'
import { stripe, PLANS } from '../lib/stripe'
import { supabaseAdmin } from '../lib/supabaseAdmin'

const router = Router()

// Internal types for Stripe event data objects
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

// Helper: update plan in DB by stripe_customer_id.
// Falls back to Stripe customer metadata (userId) if stripe_customer_id is not stored in DB.
async function syncPlan(customerId: string, plan: string, reason: string) {
  const { data: updated, error } = await supabaseAdmin
    .from('profiles')
    .update({ plan, stripe_customer_id: customerId })
    .eq('stripe_customer_id', customerId)
    .select('id')

  if (error) {
    console.error(`[webhook] Supabase update FAILED (${reason}):`, error.message)
    return
  }

  if (updated && updated.length > 0) {
    console.log(`[webhook] plan → ${plan} (${reason}) — updated ${updated.length} row(s)`)
    return
  }

  // 0 rows matched: stripe_customer_id not in DB — use Stripe metadata to find user
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

    const { data: fallbackUpdated, error: fallbackError } = await supabaseAdmin
      .from('profiles')
      .update({ plan, stripe_customer_id: customerId })
      .eq('id', userId)
      .select('id')

    if (fallbackError) {
      console.error(`[webhook] Fallback update FAILED (${reason}):`, fallbackError.message)
    } else if (fallbackUpdated && fallbackUpdated.length > 0) {
      console.log(`[webhook] plan → ${plan} via metadata fallback (${reason}) — updated ${fallbackUpdated.length} row(s)`)
    } else {
      console.error(`[webhook] Fallback also matched 0 rows for userId ${userId}`)
    }
  } catch (stripeErr: unknown) {
    const message = stripeErr instanceof Error ? stripeErr.message : 'Unknown error'
    console.error(`[webhook] Stripe customer retrieval failed:`, message)
  }
}

router.post('/create-checkout', async (req: Request, res: Response) => {
  try {
    const { userId, userEmail, plan } = req.body

    if (!userId || !userEmail || !plan) {
      return res.status(400).json({ error: 'Missing required fields: userId, userEmail, plan' })
    }

    if (!PLANS[plan as keyof typeof PLANS]?.priceId) {
      return res.status(400).json({ error: 'Invalid plan or plan not available for purchase' })
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single()

    let stripeCustomerId = profile?.stripe_customer_id

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { userId },
      })
      stripeCustomerId = customer.id

      await supabaseAdmin
        .from('profiles')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', userId)
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: PLANS[plan as keyof typeof PLANS].priceId!, quantity: 1 }],
      customer: stripeCustomerId,
      success_url: `${process.env.FRONTEND_URL}/dashboard/settings?tab=billing&success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard/settings?tab=billing`,
      metadata: { userId, plan },
    })

    res.json({ url: session.url })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Stripe checkout error:', message)
    res.status(500).json({ error: message })
  }
})

router.post('/create-portal', async (req: Request, res: Response) => {
  try {
    const { userId } = req.body

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' })
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single()

    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/dashboard/settings?tab=billing`,
    })

    res.json({ url: session.url })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Stripe portal error:', message)
    res.status(500).json({ error: message })
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

  // Respond 200 immediately — Stripe requires fast acknowledgement
  res.json({ received: true })

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as StripeCheckoutSession
        const plan = session.metadata?.plan
        const customerId = session.customer

        console.log(`[webhook] checkout.session.completed — plan: ${plan}, customer: ${customerId}`)

        if (plan && customerId) {
          await syncPlan(customerId, plan, 'checkout completed')
        }
        break
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as StripeSubscription
        const customerId = subscription.customer
        const status = subscription.status
        const cancelAtPeriodEnd = subscription.cancel_at_period_end

        console.log(
          `[webhook] subscription.updated — customer: ${customerId}, ` +
          `status: ${status}, cancel_at_period_end: ${cancelAtPeriodEnd}`
        )

        if (!customerId) break

        if (status === 'canceled' || cancelAtPeriodEnd) {
          // User cancelled (immediately or scheduled) — downgrade now.
          // Even if access technically lasts until period end,
          // we downgrade immediately to reflect the cancellation intent.
          await syncPlan(customerId, 'free', `subscription.updated status=${status} cancel_at_period_end=${cancelAtPeriodEnd}`)
        } else if (status === 'active') {
          // Active subscription with no cancellation — sync plan from priceId
          const priceId = subscription.items.data[0]?.price?.id
          if (priceId) {
            const planEntry = Object.entries(PLANS).find(
              ([, config]) => config.priceId === priceId
            )
            if (planEntry) {
              await syncPlan(customerId, planEntry[0], 'subscription.updated active')
            } else {
              console.warn(`[webhook] No matching plan for priceId: ${priceId}`)
            }
          }
        } else {
          console.log(`[webhook] Unhandled subscription status: ${status}`)
        }
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as StripeSubscription
        const customerId = subscription.customer

        console.log(`[webhook] subscription.deleted — customer: ${customerId}`)

        if (customerId) {
          await syncPlan(customerId, 'free', 'subscription.deleted')
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

router.get('/status', async (req: Request, res: Response) => {
  try {
    const { userId } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId query param' })
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('plan, stripe_customer_id')
      .eq('id', userId as string)
      .single()

    let plan: string = profile?.plan || 'free'

    // For paid plans: verify with Stripe to self-heal missed webhooks.
    // A subscription with cancel_at_period_end=true is treated as cancelled.
    if (plan !== 'free' && profile?.stripe_customer_id) {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: profile.stripe_customer_id,
          status: 'active',
          limit: 10,
        })

        // Only count subscriptions without a pending cancellation
        const trullyActive = subscriptions.data.filter(s => !s.cancel_at_period_end)

        if (trullyActive.length === 0) {
          console.log(`[billing/status] No active (non-cancelled) subscription for ${userId} — downgrading to free`)
          const { error } = await supabaseAdmin
            .from('profiles')
            .update({ plan: 'free' })
            .eq('id', userId as string)
          if (error) {
            console.error('[billing/status] Supabase update error:', error.message)
          }
          plan = 'free'
        }
      } catch (stripeErr: unknown) {
        // Stripe unreachable — fall back to DB value, never accidentally downgrade
        const message = stripeErr instanceof Error ? stripeErr.message : 'Unknown error'
        console.error('[billing/status] Stripe check failed, using DB value:', message)
      }
    }

    res.json({
      plan,
      hasStripeCustomer: !!profile?.stripe_customer_id,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Stripe status error:', message)
    res.status(500).json({ error: message })
  }
})

export default router
