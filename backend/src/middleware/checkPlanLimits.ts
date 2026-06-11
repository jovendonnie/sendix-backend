import { Request, Response, NextFunction } from 'express'
import { db } from '../lib/db'
import { AuthenticatedRequest } from './authApiKey'

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

    const { rows } = await db.query(
      'SELECT plan, emails_sent_this_month, email_limit FROM profiles WHERE id = $1',
      [userId]
    )
    const profile = rows[0]

    if (!profile) {
      console.warn('[checkEmailLimit] Could not fetch profile, skipping limit check')
      next()
      return
    }

    const plan  = profile.plan || 'free'
    const limit = (profile.email_limit as number | null) ?? PLAN_EMAIL_LIMITS[plan] ?? 3_000

    let sent: number
    if (profile.emails_sent_this_month !== null && profile.emails_sent_this_month !== undefined) {
      sent = profile.emails_sent_this_month as number
    } else {
      const startOfMonth = new Date()
      startOfMonth.setUTCDate(1)
      startOfMonth.setUTCHours(0, 0, 0, 0)
      const { rows: countRows } = await db.query(
        'SELECT COUNT(*) as count FROM messages WHERE user_id = $1 AND created_at >= $2',
        [userId, startOfMonth.toISOString()]
      )
      sent = parseInt(countRows[0]?.count || '0', 10)
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

    ;(req as any).planInfo = { plan, limit, sent }
    next()
  } catch (err) {
    console.error('[checkEmailLimit] Unexpected error, allowing send:', err)
    next()
  }
}

export async function checkApiKeyLimit(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.headers['x-user-id'] as string
    if (!userId) { next(); return }

    const { rows: profileRows } = await db.query(
      'SELECT plan FROM profiles WHERE id = $1',
      [userId]
    )
    const plan     = profileRows[0]?.plan || 'free'
    const keyLimit = PLAN_KEY_LIMITS[plan] ?? 1

    const { rows: keyRows } = await db.query(
      'SELECT COUNT(*) as count FROM api_keys WHERE user_id = $1 AND revoked = false',
      [userId]
    )
    const count = parseInt(keyRows[0]?.count || '0', 10)

    if (count >= keyLimit) {
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

export async function incrementEmailCounter(userId: string, count = 1): Promise<void> {
  try {
    await db.query(
      'UPDATE profiles SET emails_sent_this_month = COALESCE(emails_sent_this_month, 0) + $2 WHERE id = $1',
      [userId, count]
    )
  } catch (err) {
    console.error('[checkPlanLimits] Failed to increment email counter:', err)
  }
}
