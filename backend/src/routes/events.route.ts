import { Router, Response } from 'express'
import { authClerkUser, UserRequest } from '../middleware/authClerkUser'
import { listEvents, getEventsByMessage, getStats } from '../services/event.service'

const router = Router()

router.get('/stats', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const period = parseInt((req.query.period as string) || '7', 10)
    const stats = await getStats(req.userId!, period)
    return res.json(stats)
  } catch (err: any) {
    console.error('[events] stats error:', err)
    return res.status(500).json({ error: 'Failed to get stats' })
  }
})

router.get('/:messageId', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const events = await getEventsByMessage(req.params.messageId, req.userId!)
    return res.json({ events })
  } catch (err: any) {
    console.error('[events] messageId error:', err)
    return res.status(500).json({ error: 'Failed to get events' })
  }
})

router.get('/', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const {
      message_id,
      event_type,
      provider_name,
      from: dateFrom,
      to: dateTo,
      limit,
      offset,
    } = req.query as Record<string, string>

    const events = await listEvents(req.userId!, {
      messageId: message_id,
      eventType: event_type,
      providerName: provider_name,
      from: dateFrom,
      to: dateTo,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    })

    return res.json({ events })
  } catch (err: any) {
    console.error('[events] list error:', err)
    return res.status(500).json({ error: 'Failed to list events' })
  }
})

export default router
