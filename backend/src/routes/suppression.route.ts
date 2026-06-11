import { Router, Response } from 'express'
import { db } from '../lib/db'
import { authClerkUser, UserRequest } from '../middleware/authClerkUser'

const router = Router()

router.get('/', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!
    const page  = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20)
    const offset = (page - 1) * limit

    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) as count FROM suppression_list WHERE (user_id = $1 OR user_id IS NULL)',
      [userId]
    )
    const total = parseInt(countRows[0]?.count || '0', 10)

    const { rows: data } = await db.query(
      `SELECT id, email, reason, user_id, created_at
       FROM suppression_list
       WHERE (user_id = $1 OR user_id IS NULL)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    )

    return res.json({ data, total, page, limit })
  } catch (err) {
    console.error('[suppression] GET error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:email', authClerkUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!
    const email  = decodeURIComponent(req.params.email).toLowerCase().trim()

    const { rows } = await db.query(
      'SELECT id, user_id, reason FROM suppression_list WHERE email = $1 AND user_id = $2',
      [email, userId]
    )
    const entry = rows[0]

    if (!entry) {
      return res.status(404).json({ error: 'Suppression entry not found' })
    }

    await db.query('DELETE FROM suppression_list WHERE id = $1', [entry.id])

    return res.json({ ok: true })
  } catch (err) {
    console.error('[suppression] DELETE error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
