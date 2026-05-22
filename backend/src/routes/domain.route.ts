import { Router, Request, Response } from 'express'
import { domainService } from '../services/domain.service'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  try {
    const { user_id, domain } = req.body

    if (!user_id || !domain) {
      return res.status(400).json({ error: 'user_id and domain are required' })
    }

    const result = await domainService.createDomain(user_id, domain)

    if (!result.success) {
      const status = result.error === 'Domain already exists' ? 409 : 400
      return res.status(status).json({ error: result.error })
    }

    res.status(201).json({
      id: result.domain?.id,
      user_id: result.domain?.user_id,
      domain: result.domain?.domain,
      verified: result.domain?.verified,
      created_at: result.domain?.created_at
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create domain'
    res.status(500).json({ error: message })
  }
})

router.get('/', async (req: Request, res: Response) => {
  try {
    const user_id = req.query.user_id as string

    if (!user_id) {
      return res.status(400).json({ error: 'user_id query param is required' })
    }

    const domains = await domainService.getUserDomains(user_id)

    res.json({ domains })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch domains'
    res.status(500).json({ error: message })
  }
})

export default router