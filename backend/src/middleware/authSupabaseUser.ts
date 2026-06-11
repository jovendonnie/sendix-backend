import { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin'

export interface UserRequest extends Request {
  userId?: string
  userPlan?: string
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Supabase JWTs are valid for 1 hour. Caching for 2 minutes is safe and
// eliminates 2 DB roundtrips on every request for logged-in dashboard users.
const JWT_CACHE_TTL = 2 * 60 * 1000 // 2 minutes

interface CachedSession {
  userId: string
  userPlan: string
  expiresAt: number
}

const sessionCache = new Map<string, CachedSession>()

function pruneSessionCache() {
  const now = Date.now()
  for (const [k, v] of sessionCache) {
    if (v.expiresAt < now) sessionCache.delete(k)
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

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

    // 1. Serve from cache — 0 DB queries
    const cached = sessionCache.get(token)
    if (cached && cached.expiresAt > Date.now()) {
      req.userId   = cached.userId
      req.userPlan = cached.userPlan
      next()
      return
    }

    // 2. Validate JWT + fetch plan (2 DB calls, once per TTL window)
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      res.status(401).json({ error: 'Invalid or expired session token' })
      return
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('plan')
      .eq('id', user.id)
      .single()

    const userPlan = profile?.plan || 'free'

    // 3. Cache the result
    sessionCache.set(token, { userId: user.id, userPlan, expiresAt: Date.now() + JWT_CACHE_TTL })
    if (sessionCache.size > 500) pruneSessionCache()

    req.userId   = user.id
    req.userPlan = userPlan
    next()
  } catch (err) {
    console.error('[authSupabaseUser] Unexpected error:', err)
    res.status(500).json({ error: 'Authentication failed' })
  }
}

/** Call after logout or token revocation to evict cached session. */
export function invalidateSessionCache(token: string) {
  sessionCache.delete(token)
}
