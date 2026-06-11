import * as crypto from 'crypto'
import { db } from '../lib/db'

const ALGORITHM = 'aes-256-cbc'
const IV_LENGTH = 16

function getEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || ''
  if (!raw) {
    console.warn('[provider] ENCRYPTION_KEY not set — using fallback (not safe for production)')
  }
  return crypto.createHash('sha256').update(raw || 'sendix-default-key').digest()
}

export function encryptApiKey(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return iv.toString('hex') + ':' + encrypted.toString('hex')
}

export function decryptApiKey(ciphertext: string): string {
  const [ivHex, encHex] = ciphertext.split(':')
  if (!ivHex || !encHex) throw new Error('Invalid encrypted key format')
  const iv = Buffer.from(ivHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv)
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()])
  return decrypted.toString('utf8')
}

export type ProviderName = 'resend' | 'brevo' | 'ses' | 'mailgun' | 'postmark'

export interface Provider {
  id: string
  user_id: string
  provider_name: ProviderName
  priority: number
  is_fallback: boolean
  is_active: boolean
  created_at: string
  masked_key?: string
}

export async function listProviders(userId: string): Promise<Provider[]> {
  const { rows } = await db.query(
    `SELECT id, user_id, provider_name, priority, is_fallback, is_active, created_at
     FROM providers
     WHERE user_id = $1
     ORDER BY priority ASC`,
    [userId]
  )
  return rows
}

export async function createProvider(
  userId: string,
  providerName: ProviderName,
  apiKey: string,
  priority: number,
  isFallback: boolean,
  isActive: boolean
): Promise<Provider> {
  const encrypted = encryptApiKey(apiKey)
  const { rows } = await db.query(
    `INSERT INTO providers (user_id, provider_name, api_key_encrypted, priority, is_fallback, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, provider_name, priority, is_fallback, is_active, created_at`,
    [userId, providerName, encrypted, priority, isFallback, isActive]
  )
  return rows[0]
}

export async function updateProvider(
  id: string,
  userId: string,
  updates: Partial<{ priority: number; is_fallback: boolean; is_active: boolean }>
): Promise<Provider | null> {
  const fields: string[] = []
  const values: any[] = []
  let idx = 1

  if (updates.priority !== undefined) { fields.push(`priority = $${idx++}`); values.push(updates.priority) }
  if (updates.is_fallback !== undefined) { fields.push(`is_fallback = $${idx++}`); values.push(updates.is_fallback) }
  if (updates.is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(updates.is_active) }

  if (fields.length === 0) return null

  values.push(id, userId)
  const { rows } = await db.query(
    `UPDATE providers SET ${fields.join(', ')}
     WHERE id = $${idx++} AND user_id = $${idx}
     RETURNING id, user_id, provider_name, priority, is_fallback, is_active, created_at`,
    values
  )
  return rows[0] ?? null
}

export async function deleteProvider(id: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'DELETE FROM providers WHERE id = $1 AND user_id = $2',
    [id, userId]
  )
  return (rowCount ?? 0) > 0
}

export async function getProviderWithKey(id: string, userId: string) {
  const { rows } = await db.query(
    'SELECT * FROM providers WHERE id = $1 AND user_id = $2',
    [id, userId]
  )
  if (!rows[0]) return null
  return { ...rows[0], decrypted_key: decryptApiKey(rows[0].api_key_encrypted) }
}

export async function getActiveProviders(userId: string) {
  const { rows } = await db.query(
    `SELECT id, provider_name, api_key_encrypted, priority, is_fallback
     FROM providers
     WHERE user_id = $1 AND is_active = true
     ORDER BY is_fallback ASC, priority ASC`,
    [userId]
  )
  return rows.map(r => ({ ...r, decrypted_key: decryptApiKey(r.api_key_encrypted) }))
}

export async function validateProviderKey(id: string, userId: string): Promise<boolean> {
  const provider = await getProviderWithKey(id, userId)
  if (!provider) return false

  try {
    switch (provider.provider_name as ProviderName) {
      case 'resend': {
        const res = await fetch('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${provider.decrypted_key}` },
        })
        return res.status === 200 || res.status === 404
      }
      case 'brevo': {
        const res = await fetch('https://api.brevo.com/v3/account', {
          headers: { 'api-key': provider.decrypted_key },
        })
        return res.ok
      }
      case 'mailgun': {
        const [apiKey, domain] = provider.decrypted_key.split('|')
        const base64 = Buffer.from(`api:${apiKey}`).toString('base64')
        const res = await fetch(`https://api.mailgun.net/v3/domains/${domain || ''}`, {
          headers: { Authorization: `Basic ${base64}` },
        })
        return res.ok || res.status === 404
      }
      case 'postmark': {
        const res = await fetch('https://api.postmarkapp.com/server', {
          headers: { 'X-Postmark-Server-Token': provider.decrypted_key },
        })
        return res.ok
      }
      case 'ses':
        return true
      default:
        return false
    }
  } catch {
    return false
  }
}
