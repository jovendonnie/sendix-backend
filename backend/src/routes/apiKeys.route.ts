import { Router, Request, Response } from 'express'
import { apiKeyService } from '../services/apiKey.service'
import { db } from '../lib/db'
import { checkApiKeyLimit } from '../middleware/checkPlanLimits'

const router = Router()

router.post('/', checkApiKeyLimit, async (req: Request, res: Response) => {
  try {
    const user_id = req.headers['x-user-id'] as string
    const { name, scope } = req.body

    if (!user_id) {
      return res.status(401).json({ error: 'x-user-id header is required' })
    }
    if (!name) {
      return res.status(400).json({ error: 'name is required' })
    }

    const { rows } = await db.query('SELECT plan FROM profiles WHERE id = $1', [user_id])
    const plan = rows[0]?.plan || 'free'

    const { rawKey, apiKey } = await apiKeyService.createApiKey(user_id, name, scope || 'full_access', plan)

    return res.status(201).json({
      apiKey:     rawKey,
      id:         apiKey.id,
      name:       apiKey.name,
      scope:      apiKey.scope,
      created_at: apiKey.created_at,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create API key'
    const status  = message === 'API key limit reached' ? 403 : 500
    return res.status(status).json({ error: message })
  }
})

router.get('/', async (req: Request, res: Response) => {
  try {
    const user_id = req.query.user_id as string

    if (!user_id) {
      return res.status(400).json({ error: 'user_id query param is required' })
    }

    const apiKeys = await apiKeyService.getUserApiKeys(user_id)
    return res.json({ api_keys: apiKeys })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch API keys'
    return res.status(500).json({ error: message })
  }
})

router.patch('/:id/revoke', async (req: Request, res: Response) => {
  try {
    await apiKeyService.revokeApiKey(req.params.id)
    return res.json({ message: 'API key revoked' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to revoke API key'
    return res.status(500).json({ error: message })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const user_id = req.headers['x-user-id'] as string

    if (!user_id) {
      return res.status(401).json({ error: 'x-user-id header is required' })
    }

    const result = await db.query(
      'DELETE FROM api_keys WHERE id = $1 AND user_id = $2',
      [id, user_id]
    )

    if (!result.rowCount) {
      return res.status(404).json({ error: 'API key not found' })
    }

    return res.json({ message: 'API key deleted' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete API key'
    return res.status(500).json({ error: message })
  }
})

export default router
