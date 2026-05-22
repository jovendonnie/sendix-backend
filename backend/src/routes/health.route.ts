import { Router, Request, Response } from 'express'

const healthRouter = Router()

/**
 * GET /api/health
 * Health check endpoint for monitoring and load balancers
 */
healthRouter.get('/', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'backend',
    timestamp: new Date().toISOString()
  })
})

export default healthRouter
