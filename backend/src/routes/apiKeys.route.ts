import { Router, Request, Response } from 'express'
import { apiKeyService } from '../services/apiKey.service'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { checkApiKeyLimit } from '../middleware/checkPlanLimits'

const router = Router()

router.post('/', checkApiKeyLimit, async (req: Request, res: Response) => {
  try {
    console.log('POST /api/api-keys - Body:', JSON.stringify(req.body))
    
    const user_id = req.headers['x-user-id'] as string
    const { name, scope } = req.body

    console.log('User ID from header:', user_id)
    console.log('Name from body:', name)

    if (!user_id) {
      return res.status(401).json({ error: 'x-user-id header is required' })
    }
    if (!name) {
      return res.status(400).json({ error: 'name is required' })
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('plan')
      .eq('id', user_id)
      .single()

    const plan = profile?.plan || 'free'

    console.log('Creating API key for user:', user_id, 'name:', name, 'plan:', plan)
    
    const { rawKey, apiKey } = await apiKeyService.createApiKey(user_id, name, scope || 'full_access', plan)

    console.log('API key created successfully:', apiKey.id)

    res.status(201).json({
      apiKey: rawKey,
      id: apiKey.id,
      name: apiKey.name,
      scope: apiKey.scope,
      created_at: apiKey.created_at
    })
  } catch (error) {
    console.error('Error creating API key:', error)
    const message = error instanceof Error ? error.message : 'Failed to create API key'
    const status = message === 'API key limit reached' ? 403 : 500
    res.status(status).json({ error: message })
  }
})

router.get('/', async (req: Request, res: Response) => {
  try {
    const user_id = req.query.user_id as string

    if (!user_id) {
      return res.status(400).json({ error: 'user_id query param is required' })
    }

    const apiKeys = await apiKeyService.getUserApiKeys(user_id)

    res.json({ api_keys: apiKeys })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch API keys'
    res.status(500).json({ error: message })
  }
})

router.patch('/:id/revoke', async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    await apiKeyService.revokeApiKey(id)

    res.json({ message: 'API key revoked' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to revoke API key'
    res.status(500).json({ error: message })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const user_id = req.headers['x-user-id'] as string

    if (!user_id) {
      return res.status(401).json({ error: 'x-user-id header is required' })
    }

    console.log('Deleting API key:', id, 'for user:', user_id)

    const { error } = await supabaseAdmin
      .from('api_keys')
      .delete()
      .eq('id', id)
      .eq('user_id', user_id)

    if (error) {
      console.error('Delete error:', error)
      throw new Error(error.message)
    }

    res.json({ message: 'API key deleted' })
  } catch (error) {
    console.error('Error deleting API key:', error)
    const message = error instanceof Error ? error.message : 'Failed to delete API key'
    res.status(500).json({ error: message })
  }
})

export default router