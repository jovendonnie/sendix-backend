import { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcrypt'
import { db } from '../lib/db'

export interface AuthenticatedRequest extends Request {
  apiKey?: {
    id: string
    user_id: string
    name: string
    scope?: string
    organization_id?: string | null
  }
}

const KEY_CACHE_TTL = 5 * 60 * 1000

interface CachedKey {
  id: string
  user_id: string
  name: string
  scope: string
  organization_id: string | null
  expiresAt: number
}

const keyCache = new Map<string, CachedKey>()

function pruneKeyCache() {
  const now = Date.now()
  for (const [k, v] of keyCache) {
    if (v.expiresAt < now) keyCache.delete(k)
  }
}

export async function authApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization header required' })
      return
    }

    const rawKey = authHeader.slice(7)
    if (!rawKey) {
      res.status(401).json({ error: 'API key required' })
      return
    }

    const cached = keyCache.get(rawKey)
    if (cached && cached.expiresAt > Date.now()) {
      ;(req as AuthenticatedRequest).apiKey = {
        id: cached.id,
        user_id: cached.user_id,
        name: cached.name,
        scope: cached.scope,
        organization_id: cached.organization_id,
      }
      next()
      return
    }

    const keyPrefix = rawKey.substring(0, 16)

    const { rows: keys } = await db.query(
      'SELECT id, user_id, name, key_hash, scope, organization_id FROM api_keys WHERE key_prefix = $1 AND revoked = false',
      [keyPrefix]
    )

    if (!keys || keys.length === 0) {
      res.status(401).json({ error: 'Invalid API key' })
      return
    }

    for (const key of keys) {
      if (!key.key_hash) continue

      const isMatch = await bcrypt.compare(rawKey, key.key_hash)
      if (isMatch) {
        const entry: CachedKey = {
          id: key.id,
          user_id: key.user_id,
          name: key.name,
          scope: key.scope || 'full_access',
          organization_id: key.organization_id ?? null,
          expiresAt: Date.now() + KEY_CACHE_TTL,
        }

        keyCache.set(rawKey, entry)
        if (keyCache.size > 1000) pruneKeyCache()

        ;(req as AuthenticatedRequest).apiKey = {
          id: entry.id,
          user_id: entry.user_id,
          name: entry.name,
          scope: entry.scope,
          organization_id: entry.organization_id,
        }
        next()
        return
      }
    }

    res.status(401).json({ error: 'Invalid API key' })
  } catch (err) {
    console.error('[authApiKey] Unexpected error:', err)
    res.status(500).json({ error: 'Authentication failed' })
  }
}

export function checkScope(
  req: AuthenticatedRequest,
  requiredScope: 'full_access' | 'send_only' | 'read_only'
): boolean {
  const scope = req.apiKey?.scope || 'full_access'
  if (scope === 'full_access') return true
  if (scope === 'send_only' && req.method === 'POST') return true
  if (scope === 'read_only' && req.method === 'GET') return true
  return false
}

export function invalidateKeyCache(rawKey: string) {
  keyCache.delete(rawKey)
}

/** Invalidate a cached key by its database ID (used after revoke/delete when raw key is unavailable). */
export function invalidateKeyCacheById(keyId: string) {
  for (const [rawKey, cached] of keyCache) {
    if (cached.id === keyId) {
      keyCache.delete(rawKey)
      break
    }
  }
}
