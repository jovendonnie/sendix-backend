import { Router, Response } from 'express'
import { apiKeyService } from '../services/apiKey.service'
import { db } from '../lib/db'
import { checkApiKeyLimit } from '../middleware/checkPlanLimits'
import { authSupabaseUser, UserRequest } from '../middleware/authSupabaseUser'
import { invalidateKeyCacheById } from '../middleware/authApiKey'

const router = Router()

// All routes require a valid Supabase JWT.
// User identity is taken from req.userId (set by authSupabaseUser), never from request headers or body.
router.use(authSupabaseUser)

router.post('/', checkApiKeyLimit, async (req: UserRequest, res: Response) => {
  try {
    const user_id = req.userId!
    const { name, scope } = req.body

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

router.get('/', async (req: UserRequest, res: Response) => {
  try {
    const apiKeys = await apiKeyService.getUserApiKeys(req.userId!)
    return res.json({ api_keys: apiKeys })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch API keys'
    return res.status(500).json({ error: message })
  }
})

router.patch('/:id/revoke', async (req: UserRequest, res: Response) => {
  try {
    const { id } = req.params
    const userId = req.userId!

    const { rows } = await db.query(
      'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2',
      [id, userId]
    )
    if (!rows.length) {
      return res.status(404).json({ error: 'API key not found' })
    }

    await apiKeyService.revokeApiKey(id)
    invalidateKeyCacheById(id)

    return res.json({ message: 'API key revoked' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to revoke API key'
    return res.status(500).json({ error: message })
  }
})

router.delete('/:id', async (req: UserRequest, res: Response) => {
  try {
    const { id } = req.params
    const userId = req.userId!

    const result = await db.query(
      'DELETE FROM api_keys WHERE id = $1 AND user_id = $2',
      [id, userId]
    )

    if (!result.rowCount) {
      return res.status(404).json({ error: 'API key not found' })
    }

    invalidateKeyCacheById(id)

    return res.json({ message: 'API key deleted' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete API key'
    return res.status(500).json({ error: message })
  }
})

export default router
