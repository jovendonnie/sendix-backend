import { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcrypt'
import { supabaseAdmin } from '../lib/supabaseAdmin'

export interface AuthenticatedRequest extends Request {
  apiKey?: {
    id: string
    user_id: string
    name: string
    scope?: string
    organization_id?: string | null
  }
}

export async function authApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    console.log('Validating API key...')

    const authHeader = req.headers.authorization
    console.log('FULL AUTH HEADER:', authHeader)

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization header required' })
      return
    }

    const rawKey = authHeader.slice(7)
    console.log('EXTRACTED KEY:', rawKey)

    if (!rawKey) {
      res.status(401).json({ error: 'API key required' })
      return
    }

    console.log('Fetching API keys from database...')

    const { data: keys, error } = await supabaseAdmin
      .from('api_keys')
      .select('id, user_id, name, key_hash, scope, organization_id')
      .eq('revoked', false)

    if (error) {
      console.error('Error fetching API keys:', error)
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    if (!keys || keys.length === 0) {
      console.log('No active API keys found')
      res.status(401).json({ error: 'Invalid API key' })
      return
    }

    console.log(`Checking against ${keys.length} active keys...`)

    for (const key of keys) {
      console.log('RAW KEY:', rawKey)
      console.log('KEY ID:', key.id)
      console.log('HASH FROM DB:', key.key_hash ? 'exists' : 'missing')
      console.log('KEY FORMAT:', rawKey.substring(0, 8))
      
      if (key.key_hash) {
        try {
          const isMatch = await bcrypt.compare(rawKey, key.key_hash)
          console.log('Match result:', isMatch)
          
          if (isMatch) {
             console.log('MATCH FOUND:', key.id)
             ;(req as AuthenticatedRequest).apiKey = {
               id: key.id,
               user_id: key.user_id,
               name: key.name,
               scope: key.scope || 'full_access',
               organization_id: (key as any).organization_id ?? null,
             }
             next()
             return
           }
        } catch (compareErr) {
          console.error('Bcrypt compare error:', compareErr)
        }
      }
    }

    console.log('No matching API key found')
    res.status(401).json({ error: 'Invalid API key' })
  } catch (err) {
    console.error('Auth error:', err)
    res.status(500).json({ error: 'Authentication failed' })
  }
}

/**
 * Check if the API key scope allows the requested operation.
 * full_access: can do everything
 * send_only: can only POST to /emails endpoints
 * read_only: can only GET /emails endpoints
 */
export function checkScope(req: AuthenticatedRequest, requiredScope: 'full_access' | 'send_only' | 'read_only'): boolean {
  const scope = req.apiKey?.scope || 'full_access'

  if (scope === 'full_access') return true
  if (scope === 'send_only' && req.method === 'POST') return true
  if (scope === 'read_only' && req.method === 'GET') return true

  return false
}