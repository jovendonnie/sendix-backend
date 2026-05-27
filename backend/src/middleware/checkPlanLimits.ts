import { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { AuthenticatedRequest } from './authApiKey'

// ─── Plan limits (source of truth) ───────────────────────────────────────────

const PLAN_EMAIL_LIMITS: Record<string, number> = {
  free:   3_000,
  pro:    50_000,
  agency: 200_000,
}

const PLAN_KEY_LIMITS: Record<string, number> = {
  free:   1,
  pro:    5,
  agency: 999,
}

// ─── Email send limit ─────────────────────────────────────────────────────────

/**
 * Middleware that enforces monthly email send limits.
 *
 * Reads `emails_sent_this_month` and `email_limit` directly from `profiles`
 * (O(1) — no aggregation). These columns are added by Migración 1.
 *
 * Must run AFTER `authApiKey`.
 */
export async function checkEmailLimit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.apiKey?.user_id
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' })
      return
    }

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('plan, emails_sent_this_month, email_limit')
      .eq('id', userId)
      .single()

    if (error || !profile) {
      // Can't verify limits → allow the send but log the issue
      console.warn('[checkEmailLimit] Could not fetch profile, skipping limit check:', error?.message)
      next()
      return
    }

    const plan = profile.plan || 'free'
    const limit = (profile.email_limit as number | null) ?? PLAN_EMAIL_LIMITS[plan] ?? 3_000

    // If the counter column hasn't been migrated yet (null), fall back to
    // counting directly from the messages table (always accurate, just slower).
    let sent: number
    if (profile.emails_sent_this_month !== null && profile.emails_sent_this_month !== undefined) {
      sent = profile.emails_sent_this_month as number
    } else {
      const startOfMonth = new Date()
      startOfMonth.setUTCDate(1)
      startOfMonth.setUTCHours(0, 0, 0, 0)
      const { count } = await supabaseAdmin
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', startOfMonth.toISOString())
      sent = count || 0
    }

    if (sent >= limit) {
      res.status(402).json({
        success: false,
        error:   `Monthly email limit reached. Your ${plan} plan allows ${limit.toLocaleString()} emails/month.`,
        code:    'PLAN_LIMIT_REACHED',
        sent,
        limit,
        plan,
      })
      return
    }

    // Attach for downstream use
    ;(req as any).planInfo = { plan, limit, sent }
    next()
  } catch (err) {
    // Never block a send due to a limit-check crash — log and allow
    console.error('[checkEmailLimit] Unexpected error, allowing send:', err)
    next()
  }
}

// ─── API key count limit ──────────────────────────────────────────────────────

export async function checkApiKeyLimit(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.headers['x-user-id'] as string
    if (!userId) { next(); return }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single()

    const plan     = profile?.plan || 'free'
    const keyLimit = PLAN_KEY_LIMITS[plan] ?? 1

    const { count } = await supabaseAdmin
      .from('api_keys')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('revoked', false)

    if ((count || 0) >= keyLimit) {
      res.status(402).json({
        error: `API key limit reached. Your ${plan} plan allows ${keyLimit === 999 ? 'unlimited' : keyLimit} API key${keyLimit === 1 ? '' : 's'}.`,
        code:  'API_KEY_LIMIT_REACHED',
        plan,
        limit: keyLimit,
      })
      return
    }

    next()
  } catch (err) {
    next(err)
  }
}

// ─── Counter increment helper (used by send route) ───────────────────────────

/**
 * Increment `emails_sent_this_month` for a user after a successful send.
 * Pass `count = batch.length` for bulk sends.
 *
 * Uses fetch-then-update (not RPC) to avoid requiring a DB function.
 * Race condition is negligible at SendIX's scale.
 */
export async function incrementEmailCounter(userId: string, count = 1): Promise<void> {
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('emails_sent_this_month')
      .eq('id', userId)
      .single()

    const current = (profile?.emails_sent_this_month as number | null) ?? 0

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ emails_sent_this_month: current + count })
      .eq('id', userId)

    if (error) {
      console.error('[checkPlanLimits] Failed to increment email counter:', error.message)
    }
  } catch (err) {
    // Non-fatal: a counter miss is better than losing the send
    console.error('[checkPlanLimits] Unexpected error incrementing counter:', err)
  }
}
