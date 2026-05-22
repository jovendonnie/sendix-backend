import crypto from 'crypto'
import bcrypt from 'bcrypt'
import { supabaseAdmin } from '../lib/supabaseAdmin'

export interface ApiKey {
  id: string
  user_id: string
  name: string
  last4: string
  revoked: boolean
  scope: 'full_access' | 'send_only' | 'read_only'
  key_hash?: string
  raw_key?: string
  created_at: string
}

function getLast4(key: string): string {
  return key.slice(-4)
}

async function countActiveKeys(userId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('api_keys')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('revoked', false)

  console.log('Active keys count for', userId, ':', count)

  if (error) throw new Error(error.message)
  return count || 0
}

async function createApiKey(userId: string, name: string, scope: 'full_access' | 'send_only' | 'read_only' = 'full_access', plan: string = 'free'): Promise<{ rawKey: string; apiKey: ApiKey }> {
  const PLAN_KEY_LIMITS: Record<string, number> = {
    free: 1,
    pro: 5,
    agency: 999
  }
  const maxKeys = PLAN_KEY_LIMITS[plan] || 1
  const activeCount = await countActiveKeys(userId)
  console.log('Current active count:', activeCount, 'max:', maxKeys, 'plan:', plan)
  
  if (activeCount >= maxKeys) {
    throw new Error('API key limit reached')
  }

  const rawKey = "sk_live_" + crypto.randomUUID()
  console.log("RAW KEY GENERATED:", rawKey)
  
  const hashed = await bcrypt.hash(rawKey, 10)
  console.log("HASH SAVED:", hashed)
  
  const last4 = getLast4(rawKey)

  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .insert({ user_id: userId, name, key_hash: hashed, raw_key: rawKey, last4, revoked: false, scope })
    .select()
    .single()

  if (error) throw new Error(error.message)
  if (!data) throw new Error('Failed to create API key')

  const apiKey: ApiKey = {
    id: data.id,
    user_id: data.user_id,
    name: data.name,
    last4: data.last4,
    revoked: data.revoked,
    scope: data.scope || 'full_access',
    raw_key: data.raw_key,
    created_at: data.created_at
  }

  return { rawKey, apiKey }
}

async function getUserApiKeys(userId: string): Promise<Omit<ApiKey, 'key_hash'>[]> {
  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .select('id, user_id, name, last4, revoked, raw_key, created_at, scope')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data || []).map(key => ({
    ...key,
    scope: key.scope || 'full_access'
  }))
}

async function revokeApiKey(id: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('api_keys')
    .update({ revoked: true })
    .eq('id', id)
    .eq('revoked', false)

  if (error) throw new Error(error.message)
}

async function validateApiKey(rawKey: string): Promise<ApiKey | null> {
  const { data: keys, error } = await supabaseAdmin
    .from('api_keys')
    .select('id, user_id, name, last4, revoked, key_hash, created_at, scope')
    .eq('revoked', false)

  if (error || !keys) return null

  for (const key of keys) {
    if (key.key_hash && await bcrypt.compare(rawKey, key.key_hash)) {
      return {
        id: key.id,
        user_id: key.user_id,
        name: key.name,
        last4: key.last4,
        revoked: key.revoked,
        scope: key.scope || 'full_access',
        created_at: key.created_at
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