import crypto from 'crypto'
import bcrypt from 'bcrypt'
import { db } from '../lib/db'

export interface ApiKey {
  id: string
  user_id: string
  name: string
  last4: string
  revoked: boolean
  scope: 'full_access' | 'send_only' | 'read_only'
  created_at: string
}

function getLast4(key: string): string {
  return key.slice(-4)
}

async function countActiveKeys(userId: string): Promise<number> {
  const { rows } = await db.query(
    'SELECT COUNT(*) as count FROM api_keys WHERE user_id = $1 AND revoked = false',
    [userId]
  )
  return parseInt(rows[0]?.count || '0', 10)
}

async function createApiKey(
  userId: string,
  name: string,
  scope: 'full_access' | 'send_only' | 'read_only' = 'full_access',
  plan = 'free'
): Promise<{ rawKey: string; apiKey: ApiKey }> {
  const PLAN_KEY_LIMITS: Record<string, number> = { free: 1, pro: 5, agency: 999 }
  const maxKeys    = PLAN_KEY_LIMITS[plan] || 1
  const activeCount = await countActiveKeys(userId)

  if (activeCount >= maxKeys) {
    throw new Error('API key limit reached')
  }

  const rawKey    = 'sk_live_' + crypto.randomUUID()
  const hashed    = await bcrypt.hash(rawKey, 10)
  const last4     = getLast4(rawKey)
  const keyPrefix = rawKey.substring(0, 16)

  const { rows } = await db.query(
    `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, last4, revoked, scope)
     VALUES ($1, $2, $3, $4, $5, false, $6)
     RETURNING *`,
    [userId, name, hashed, keyPrefix, last4, scope]
  )

  const data = rows[0]
  if (!data) throw new Error('Failed to create API key')

  return {
    rawKey,
    apiKey: {
      id:         data.id,
      user_id:    data.user_id,
      name:       data.name,
      last4:      data.last4,
      revoked:    data.revoked,
      scope:      data.scope || 'full_access',
      created_at: data.created_at,
    },
  }
}

async function getUserApiKeys(userId: string): Promise<Omit<ApiKey, never>[]> {
  const { rows } = await db.query(
    'SELECT id, user_id, name, last4, revoked, created_at, scope FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  )
  return rows.map(key => ({ ...key, scope: key.scope || 'full_access' }))
}

async function revokeApiKey(id: string): Promise<void> {
  await db.query(
    'UPDATE api_keys SET revoked = true WHERE id = $1 AND revoked = false',
    [id]
  )
}

async function validateApiKey(rawKey: string): Promise<ApiKey | null> {
  const keyPrefix = rawKey.substring(0, 16)
  const { rows: keys } = await db.query(
    'SELECT id, user_id, name, last4, revoked, key_hash, created_at, scope FROM api_keys WHERE key_prefix = $1 AND revoked = false',
    [keyPrefix]
  )

  for (const key of keys) {
    if (key.key_hash && await bcrypt.compare(rawKey, key.key_hash)) {
      return {
        id:         key.id,
        user_id:    key.user_id,
        name:       key.name,
        last4:      key.last4,
        revoked:    key.revoked,
        scope:      key.scope || 'full_access',
        created_at: key.created_at,
      }
    }
  }

  return null
}

export const apiKeyService = {
  createApiKey,
  getUserApiKeys,
  revokeApiKey,
  validateApiKey,
}
