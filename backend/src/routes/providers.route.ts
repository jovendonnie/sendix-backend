import { Router, Response } from 'express'
import { authClerkUser, UserRequest } from '../middleware/authClerkUser'
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  validateProviderKey,
  ProviderName,
} from '../services/provider.service'

const router = Router()

const VALID_PROVIDERS: ProviderName[] = ['resend', 'brevo', 'ses', 'mailgun', 'postmark']

router.get('/', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const providers = await listProviders(req.userId!)
    return res.json({ providers })
  } catch (err: any) {
    console.error('[providers] GET error:', err)
    return res.status(500).json({ error: 'Failed to list providers' })
  }
})

router.post('/', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const { provider_name, api_key, priority, is_fallback = false, is_active = true } = req.body

    if (!provider_name || !VALID_PROVIDERS.includes(provider_name)) {
      return res.status(400).json({ error: `provider_name must be one of: ${VALID_PROVIDERS.join(', ')}` })
    }
    if (!api_key || typeof api_key !== 'string' || api_key.trim().length === 0) {
      return res.status(400).json({ error: 'api_key is required' })
    }

    const existing = await listProviders(req.userId!)
    const resolvedPriority = typeof priority === 'number' ? priority : existing.length + 1

    const provider = await createProvider(
      req.userId!,
      provider_name as ProviderName,
      api_key.trim(),
      resolvedPriority,
      Boolean(is_fallback),
      Boolean(is_active)
    )

    return res.status(201).json({ provider })
  } catch (err: any) {
    console.error('[providers] POST error:', err)
    return res.status(500).json({ error: 'Failed to create provider' })
  }
})

router.put('/:id', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const { id } = req.params
    const { priority, is_fallback, is_active } = req.body

    const updates: any = {}
    if (priority !== undefined) updates.priority = priority
    if (is_fallback !== undefined) updates.is_fallback = Boolean(is_fallback)
    if (is_active !== undefined) updates.is_active = Boolean(is_active)

    const updated = await updateProvider(id, req.userId!, updates)
    if (!updated) return res.status(404).json({ error: 'Provider not found' })

    return res.json({ provider: updated })
  } catch (err: any) {
    console.error('[providers] PUT error:', err)
    return res.status(500).json({ error: 'Failed to update provider' })
  }
})

router.delete('/:id', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const deleted = await deleteProvider(req.params.id, req.userId!)
    if (!deleted) return res.status(404).json({ error: 'Provider not found' })
    return res.json({ success: true })
  } catch (err: any) {
    console.error('[providers] DELETE error:', err)
    return res.status(500).json({ error: 'Failed to delete provider' })
  }
})

router.post('/:id/validate', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const valid = await validateProviderKey(req.params.id, req.userId!)
    return res.json({ valid })
  } catch (err: any) {
    console.error('[providers] validate error:', err)
    return res.status(500).json({ error: 'Validation failed', valid: false })
  }
})

export default router
