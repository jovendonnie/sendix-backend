import { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin'

/**
 * Express request extended with the authenticated Supabase user.
 * Used by domain routes (and any future route that needs a logged-in browser session).
 */
export interface UserRequest extends Request {
  userId?: string
  userPlan?: string
}

/**
 * Middleware that validates a Supabase JWT (access token) sent by the frontend.
 *
 * Expected header:
 *   Authorization: Bearer <supabase_access_token>
 *
 * On success, sets `req.userId` and `req.userPlan` for downstream handlers.
 */
export async function authSupabaseUser(
  req: UserRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization header required' })
      return
    }

    const token = authHeader.slice(7)
    if (!token) {
      res.status(401).json({ error: 'Token missing' })
      return
    }

    // Validate the JWT using the admin client
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      res.status(401).json({ error: 'Invalid or expired session token' })
      return
    }

    // Optionally load plan for downstream plan-gating checks
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('plan')
      .eq('id', user.id)
      .single()

    req.userId   = user.id
    req.userPlan = profile?.plan || 'free'
    next()
  } catch (err) {
    console.error('[authSupabaseUser] Unexpected error:', err)
    res.status(500).json({ error: 'Authentication failed' })
  }
}
