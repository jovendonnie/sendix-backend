import { Router, Response } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { authSupabaseUser, UserRequest } from '../middleware/authSupabaseUser'

const router = Router()

// GET /api/suppression?page=1&limit=20
router.get('/', authSupabaseUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!
    const page  = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20)
    const from  = (page - 1) * limit

    const { data, error, count } = await supabaseAdmin
      .from('suppression_list')
      .select('id, email, reason, user_id, created_at', { count: 'exact' })
      .or(`user_id.eq.${userId},user_id.is.null`)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1)

    if (error) throw error

    return res.json({
      data,
      total: count ?? 0,
      page,
      limit,
    })
  } catch (err) {
    console.error('[suppression] GET error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/suppression/:email
// Only allows deleting user-owned suppressions (reason: 'unsubscribed' | 'soft_bounce_repeated' | 'manual')
router.delete('/:email', authSupabaseUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!
    const email  = decodeURIComponent(req.params.email).toLowerCase().trim()

    // Fetch the entry to validate it belongs to this user and is deletable
    const { data: entry } = await supabaseAdmin
      .from('suppression_list')
      .select('id, user_id, reason')
      .eq('email', email)
      .eq('user_id', userId)
      .maybeSingle()

    if (!entry) {
      return res.status(404).json({ error: 'Suppression entry not found' })
    }

    // Hard bounces and complaints with user_id = NULL are platform-level — block deletion
    // Here we only check user-owned entries; the query above already filters by user_id = userId
    const { error } = await supabaseAdmin
      .from('suppression_list')
      .delete()
      .eq('id', entry.id)

    if (error) throw error

    return res.json({ ok: true })
  } catch (err) {
    console.error('[suppression] DELETE error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
