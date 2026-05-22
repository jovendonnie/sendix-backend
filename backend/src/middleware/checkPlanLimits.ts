import { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { AuthenticatedRequest } from './authApiKey'

export async function checkEmailLimit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.apiKey?.user_id
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single()

    const plan = profile?.plan || 'free'

    const LIMITS: Record<string, number> = {
      free: 3000,
      pro: 50000,
      agency: 200000
    }
    const limit = LIMITS[plan] || 3000

    const startOfMonth = new Date()
    startOfMonth.setDate(1)
    startOfMonth.setHours(0, 0, 0, 0)

    const { count } = await supabaseAdmin
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', startOfMonth.toISOString())

    const currentCount = count || 0

    if (currentCount >= limit) {
      res.status(402).json({
        success: false,
        error: `Monthly email limit reached. Your ${plan} plan allows ${limit.toLocaleString()} emails/month.`,
        code: 'PLAN_LIMIT_REACHED',
        current: currentCount,
        limit,
        plan
      })
      return
    }

    ;(req as any).planInfo = { plan, limit, current: currentCount }
    next()
  } catch (err) {
    next(err)
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

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single()

    const plan = profile?.plan || 'free'

    const PLAN_KEY_LIMITS: Record<string, number> = {
      free: 1,
      pro: 5,
      agency: 999
    }
    const keyLimit = PLAN_KEY_LIMITS[plan] || 1

    const { count } = await supabaseAdmin
      .from('api_keys')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('revoked', false)

    if ((count || 0) >= keyLimit) {
      res.status(402).json({
        error: `API key limit reached. Your ${plan} plan allows ${keyLimit === 999 ? 'unlimited' : keyLimit} API key${keyLimit === 1 ? '' : 's'}.`,
        code: 'API_KEY_LIMIT_REACHED',
        plan,
        limit: keyLimit
      })
      return
    }

    next()
  } catch (err) {
    next(err)
  }
}
