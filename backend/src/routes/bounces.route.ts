import { Router, Response } from 'express'
import { db } from '../lib/db'
import { authClerkUser, UserRequest } from '../middleware/authClerkUser'

const router = Router()

router.get('/stats', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!

    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    const { rows: totalRows } = await db.query(
      `SELECT COUNT(*) as count FROM messages
       WHERE user_id = $1 AND created_at >= $2
         AND status IN ('sent', 'delivered', 'bounced', 'complained')`,
      [userId, startOfMonth]
    )
    const totalSent = parseInt(totalRows[0]?.count || '0', 10)

    const { rows: userMessages } = await db.query(
      `SELECT ses_message_id FROM messages
       WHERE user_id = $1 AND created_at >= $2 AND ses_message_id IS NOT NULL`,
      [userId, startOfMonth]
    )
    const sesMessageIds = userMessages.map(m => m.ses_message_id as string).filter(Boolean)

    let hardBounces = 0
    let complaints  = 0

    if (sesMessageIds.length > 0) {
      const { rows: hbRows } = await db.query(
        `SELECT COUNT(*) as count FROM bounce_events
         WHERE event_type = 'hard_bounce' AND created_at >= $1 AND message_id = ANY($2)`,
        [startOfMonth, sesMessageIds]
      )
      hardBounces = parseInt(hbRows[0]?.count || '0', 10)

      const { rows: compRows } = await db.query(
        `SELECT COUNT(*) as count FROM bounce_events
         WHERE event_type = 'complaint' AND created_at >= $1 AND message_id = ANY($2)`,
        [startOfMonth, sesMessageIds]
      )
      complaints = parseInt(compRows[0]?.count || '0', 10)
    }

    const total         = totalSent
    const bounceRate    = total > 0 ? (hardBounces / total) * 100 : 0
    const complaintRate = total > 0 ? (complaints  / total) * 100 : 0

    return res.json({
      period:         `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      totalSent:      total,
      hardBounces,
      complaints,
      bounceRate:     Math.round(bounceRate * 100) / 100,
      complaintRate:  Math.round(complaintRate * 10000) / 10000,
      bounceWarning:  bounceRate > 1.5,
      bounceDanger:   bounceRate > 3,
      complaintAlert: complaintRate > 0.05,
    })
  } catch (err) {
    console.error('[bounces] stats error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
