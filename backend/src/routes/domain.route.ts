import { Router, Response } from 'express'
import { authClerkUser, UserRequest } from '../middleware/authClerkUser'
import {
  registerDomain,
  verifyDomainStatus,
  revokeDomain,
} from '../services/domain-ses.service'
import { db } from '../lib/db'

const router = Router()

router.use(authClerkUser)

router.get('/', async (req: UserRequest, res: Response) => {
  try {
    const userId = req.userId!

    const { rows } = await db.query(
      `SELECT id, domain, verified, ses_verification_status, ses_dkim_tokens,
              ses_verified_at, verification_attempts, created_at
       FROM domains
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    )

    return res.json({ domains: rows })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch domains'
    return res.status(500).json({ error: message })
  }
})

router.post('/', async (req: UserRequest, res: Response) => {
  try {
    const userId   = req.userId!
    const userPlan = req.userPlan || 'free'
    const { domain, organization_id } = req.body

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain is required' })
    }

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
      domain:     result.domain,
      dkimTokens: result.dkimTokens,
      dnsRecords: buildDnsRecords(result.domain!.domain, result.dkimTokens || []),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to register domain'
    return res.status(500).json({ error: message })
  }
})

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

interface DnsRecord {
  type:  string
  name:  string
  value: string
  required: boolean
  description: string
}

function buildDnsRecords(domain: string, dkimTokens: string[]): DnsRecord[] {
  const records: DnsRecord[] = []

  dkimTokens.forEach(token => {
    records.push({
      type:        'CNAME',
      name:        `${token}._domainkey.${domain}`,
      value:       `${token}.dkim.amazonses.com`,
      required:    true,
      description: 'DKIM Easy — required for email authentication',
    })
  })

  records.push({
    type:        'TXT',
    name:        domain,
    value:       'v=spf1 include:amazonses.com ~all',
    required:    true,
    description: 'SPF — authorises Amazon SES to send on behalf of this domain',
  })

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
