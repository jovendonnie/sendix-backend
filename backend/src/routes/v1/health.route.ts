import { Router, Response } from 'express'

const router = Router()

/**
 * GET /api/v1/health
 * Health check endpoint for API v1.
 *
 * @param {express.Request} req - Express request
 * @param {Response} res - Express response
 * @response { status: "ok", version: "1.0.0", timestamp: string }
 */
router.get('/', (req, res: Response) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  })
})

export default router
