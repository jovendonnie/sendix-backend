import { Router, Response } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { authSupabaseUser, UserRequest } from '../middleware/authSupabaseUser'

const router = Router()

// GET /api/bounces/stats  — bounce rate y complaint rate del mes actual
router.get('/stats', authSupabaseUser, async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!

    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    // Total emails sent this month
    const { count: totalSent } = await supabaseAdmin
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', startOfMonth)
      .in('status', ['sent', 'delivered', 'bounced', 'complained'])

    // Step 1: get the SES message IDs for this user's messages sent this month
    const { data: userMessages } = await supabaseAdmin
      .from('messages')
      .select('ses_message_id')
      .eq('user_id', userId)
      .gte('created_at', startOfMonth)
      .not('ses_message_id', 'is', null)

    const sesMessageIds = (userMessages ?? [])
      .map(m => m.ses_message_id as string)
      .filter(Boolean)

    let hardBounces = 0
    let complaints  = 0

    if (sesMessageIds.length > 0) {
      // Step 2: count bounce_events for those SES message IDs
      const { count: hb } = await supabaseAdmin
        .from('bounce_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'hard_bounce')
        .gte('created_at', startOfMonth)
        .in('message_id', sesMessageIds)

      const { count: comp } = await supabaseAdmin
        .from('bounce_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'complaint')
        .gte('created_at', startOfMonth)
        .in('message_id', sesMessageIds)

      hardBounces = hb ?? 0
      complaints  = comp ?? 0
    }

    const total         = totalSent ?? 0
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
