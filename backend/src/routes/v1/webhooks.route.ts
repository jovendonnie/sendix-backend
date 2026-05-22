import { Router, Response } from 'express'
import { supabaseAdmin } from '../../lib/supabaseAdmin'
import { authApiKey, AuthenticatedRequest } from '../../middleware/authApiKey'
import { createWebhook, getUserWebhooks, deleteWebhook } from '../../services/webhook.service'

const router = Router()

const ALLOWED_EVENTS = ['email.delivered', 'email.bounced', 'email.failed', 'email.spam']

/**
 * POST /api/v1/webhooks
 * Create a new webhook.
 *
 * @param {AuthenticatedRequest} req - Request with apiKey attached by authApiKey middleware
 * @param {Response} res - Express response
 * @reqBody { url: string, events: string[], secret: string }
 * @response { success: true, data: { webhook: {} } }
 * @response { success: false, error: string, code: string }
 */
router.post('/', authApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }

    const { url, events, secret } = req.body

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'url is required and must be a string', code: 'MISSING_FIELDS' })
    }

    try {
      new URL(url)
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid URL format', code: 'INVALID_URL' })
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, error: 'events must be a non-empty array', code: 'MISSING_FIELDS' })
    }

    const invalidEvents = events.filter(e => !ALLOWED_EVENTS.includes(e))
    if (invalidEvents.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid events: ${invalidEvents.join(', ')}. Allowed: ${ALLOWED_EVENTS.join(', ')}`,
        code: 'INVALID_EVENTS'
      })
    }

    if (!secret || typeof secret !== 'string') {
      return res.status(400).json({ success: false, error: 'secret is required and must be a string', code: 'MISSING_FIELDS' })
    }

    const webhook = await createWebhook(apiKey.user_id, url, events, secret)

    return res.status(201).json({
      success: true,
      data: { webhook }
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to create webhook',
      code: 'CREATE_ERROR'
    })
  }
})

/**
 * GET /api/v1/webhooks
 * List all webhooks for the authenticated user.
 *
 * @param {AuthenticatedRequest} req - Request with apiKey attached by authApiKey middleware
 * @param {Response} res - Express response
 * @response { success: true, data: { webhooks: [] } }
 * @response { success: false, error: string, code: string }
 */
router.get('/', authApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }

    const webhooks = await getUserWebhooks(apiKey.user_id)

    return res.json({
      success: true,
      data: { webhooks }
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to fetch webhooks',
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * DELETE /api/v1/webhooks/:id
 * Deactivate a webhook (soft delete).
 *
 * @param {AuthenticatedRequest} req - Request with apiKey attached by authApiKey middleware
 * @param {Response} res - Express response
 * @param {string} id - Webhook ID
 * @response { success: true, data: { message: string } }
 * @response { success: false, error: string, code: string }
 */
router.delete('/:id', authApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }

    const { id } = req.params

    const { data: webhook, error: fetchError } = await supabaseAdmin
      .from('webhooks')
      .select('user_id')
      .eq('id', id)
      .single()

    if (fetchError || !webhook) {
      return res.status(404).json({ success: false, error: 'Webhook not found', code: 'NOT_FOUND' })
    }

    if (webhook.user_id !== apiKey.user_id) {
      return res.status(403).json({ success: false, error: 'Forbidden', code: 'FORBIDDEN' })
    }

    await deleteWebhook(id, apiKey.user_id)

    return res.json({
      success: true,
      data: { message: 'Webhook deleted' }
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to delete webhook',
      code: 'DELETE_ERROR'
    })
  }
})

/**
 * GET /api/v1/webhooks/deliveries
 * List the latest 50 webhook deliveries for the authenticated user.
 *
 * @param {AuthenticatedRequest} req - Request with apiKey attached by authApiKey middleware
 * @param {Response} res - Express response
 * @response { success: true, data: { deliveries: [] } }
 * @response { success: false, error: string, code: string }
 */
router.get('/deliveries', authApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = req.apiKey
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }

    const { data: webhooks } = await supabaseAdmin
      .from('webhooks')
      .select('id')
      .eq('user_id', apiKey.user_id)

    if (!webhooks || webhooks.length === 0) {
      return res.json({ success: true, data: { deliveries: [] } })
    }

    const webhookIds = webhooks.map(w => w.id)

    const { data: deliveries, error } = await supabaseAdmin
      .from('webhook_deliveries')
      .select('*')
      .in('webhook_id', webhookIds)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch deliveries', code: 'DB_ERROR' })
    }

    return res.json({
      success: true,
      data: { deliveries: deliveries || [] }
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to fetch deliveries',
      code: 'FETCH_ERROR'
    })
  }
})

export default router
