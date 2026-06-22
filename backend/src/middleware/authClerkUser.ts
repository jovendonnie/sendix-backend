import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '@clerk/backend'
import { db } from '../lib/db'

export interface UserRequest extends Request {
  userId?: string
  userPlan?: string
}

const JWT_CACHE_TTL = 2 * 60 * 1000
const sessionCache = new Map<string, { userId: string; userPlan: string; expiresAt: number }>()

function pruneCache() {
  const now = Date.now()
  for (const [k, v] of sessionCache) {
    if (v.expiresAt < now) sessionCache.delete(k)
  }
}

export async function authClerkUser(
  req: UserRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = req.headers.authorization?.slice(7)
    if (!token) {
      res.status(401).json({ error: 'Token required' })
      return
    }

    const cached = sessionCache.get(token)
    if (cached && cached.expiresAt > Date.now()) {
      req.userId = cached.userId
      req.userPlan = cached.userPlan
      return next()
    }

    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! })
    if (!payload?.sub) {
      res.status(401).json({ error: 'Invalid token' })
      return
    }

    // Guarantee the profiles row exists — handles users who signed up before
    // the Clerk webhook was configured, or if the webhook failed silently.
    await db.query(
      `INSERT INTO profiles (id, plan) VALUES ($1, 'free') ON CONFLICT (id) DO NOTHING`,
      [payload.sub]
    )

    const { rows } = await db.query('SELECT plan FROM profiles WHERE id = $1', [payload.sub])
    const userPlan = rows[0]?.plan || 'free'

    sessionCache.set(token, { userId: payload.sub, userPlan, expiresAt: Date.now() + JWT_CACHE_TTL })
    if (sessionCache.size > 500) pruneCache()

    req.userId = payload.sub
    req.userPlan = userPlan
    next()
  } catch (err) {
    console.error('[authClerkUser]', err)
    res.status(401).json({ error: 'Authentication failed' })
  }
}

export function invalidateSessionCache(token: string) {
  sessionCache.delete(token)
}
