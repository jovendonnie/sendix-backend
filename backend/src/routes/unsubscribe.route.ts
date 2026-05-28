import { Router, Request, Response } from 'express'
import { processUnsubscribe, renderUnsubscribePage } from '../services/unsubscribe.service'

const router = Router()

// GET /unsubscribe?token=xxx  — public endpoint, no auth required
router.get('/', async (req: Request, res: Response) => {
  const { token } = req.query as { token?: string }

  if (!token || typeof token !== 'string') {
    const result = { ok: false, status: 'invalid' as const }
    return res.status(400).send(renderUnsubscribePage(result))
  }

  try {
    const result = await processUnsubscribe(token)
    const statusCode = result.ok ? 200 : 400
    return res.status(statusCode).send(renderUnsubscribePage(result))
  } catch (err) {
    console.error('[unsubscribe] Error processing token:', err)
    const result = { ok: false, status: 'invalid' as const }
    return res.status(500).send(renderUnsubscribePage(result))
  }
})

export default router
