import { Router, Response } from 'express'
import { authSupabaseUser, UserRequest } from '../middleware/authSupabaseUser'
import {
  registerDomain,
  verifyDomainStatus,
  revokeDomain,
} from '../services/domain-ses.service'
import { supabaseAdmin } from '../lib/supabaseAdmin'

const router = Router()

// All domain routes require a valid Supabase session from the frontend
router.use(authSupabaseUser)

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/domains
// List all domains for the authenticated user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!

    const { data, error } = await supabaseAdmin
      .from('domains')
      .select('id, domain, verified, ses_verification_status, ses_dkim_tokens, ses_verified_at, verification_attempts, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    return res.json({ domains: data || [] })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch domains'
    return res.status(500).json({ error: message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/domains
// Register a new domain with AWS SES and get CNAME tokens
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req: UserRequest, res: Response) => {
  try {
    const userId         = req.userId!
    const userPlan       = req.userPlan || 'free'
    const { domain, organization_id } = req.body

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain is required' })
    }

    // Plan gate — enforce before calling AWS
    if (!['pro', 'agency'].includes(userPlan)) {
      return res.status(403).json({
        error:   'Plan Pro o Agency requerido para verificar dominios propios',
        code:    'PLAN_REQUIRED',
        plan:    userPlan,
      })
    }

    const result = await registerDomain(userId, domain.trim(), organization_id)

    if (!result.success) {
      const status = result.error?.includes('ya está registrado') ? 409 : 400
      return res.status(status).json({ error: result.error })
    }

    return res.status(201).json({
      domain:      result.domain,
      dkimTokens:  result.dkimTokens,
      // Helper: pre-built DNS records for the frontend to display
      dnsRecords:  buildDnsRecords(result.domain!.domain, result.dkimTokens || []),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to register domain'
    return res.status(500).json({ error: message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/domains/:id/verify
// Ask SES for the current verification status
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/verify', async (req: UserRequest, res: Response) => {
  try {
    const userId   = req.userId!
    const domainId = req.params.id

    const result = await verifyDomainStatus(userId, domainId)

    if (!result.success) {
      return res.status(400).json({ error: result.error })
    }

    return res.json({ status: result.status })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to verify domain'
    return res.status(500).json({ error: message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/domains/:id
// Revoke domain from SES and delete the record
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req: UserRequest, res: Response) => {
  try {
    const userId   = req.userId!
    const domainId = req.params.id

    const result = await revokeDomain(userId, domainId)

    if (!result.success) {
      return res.status(400).json({ error: result.error })
    }

    return res.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete domain'
    return res.status(500).json({ error: message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface DnsRecord {
  type:  string
  name:  string
  value: string
  required: boolean
  description: string
}

function buildDnsRecords(domain: string, dkimTokens: string[]): DnsRecord[] {
  const records: DnsRecord[] = []

  // DKIM CNAME records (3 tokens from Easy DKIM)
  dkimTokens.forEach(token => {
    records.push({
      type:        'CNAME',
      name:        `${token}._domainkey.${domain}`,
      value:       `${token}.dkim.amazonses.com`,
      required:    true,
      description: 'DKIM Easy — required for email authentication',
    })
  })

  // SPF
  records.push({
    type:        'TXT',
    name:        domain,
    value:       'v=spf1 include:amazonses.com ~all',
    required:    true,
    description: 'SPF — authorises Amazon SES to send on behalf of this domain',
  })

  // DMARC (recommended)
  records.push({
    type:        'TXT',
    name:        `_dmarc.${domain}`,
    value:       `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}; pct=100`,
    required:    false,
    description: 'DMARC — protects against spoofing (recommended)',
  })

  return records
}

export default router
