import {
  VerifyDomainDkimCommand,
  GetIdentityVerificationAttributesCommand,
  DeleteIdentityCommand,
} from '@aws-sdk/client-ses'
import { getSesClient } from '../lib/ses-client'
import { db } from '../lib/db'
import { clearTransporterCache } from '../lib/smtp'

export type SesVerificationStatus = 'not_started' | 'pending' | 'verified' | 'failed'

export interface DomainRecord {
  id: string
  user_id: string
  domain: string
  verified: boolean
  ses_verification_status: SesVerificationStatus
  ses_dkim_tokens: string[] | null
  ses_verified_at: string | null
  verification_attempts: number
  created_at: string
}

export async function registerDomain(
  userId: string,
  domain: string,
  organizationId?: string
): Promise<{ success: boolean; domain?: DomainRecord; dkimTokens?: string[]; error?: string }> {
  try {
    const { rows: profileRows } = await db.query(
      'SELECT plan FROM profiles WHERE id = $1',
      [userId]
    )
    const plan = profileRows[0]?.plan || 'free'

    if (!['pro', 'agency'].includes(plan)) {
      return { success: false, error: 'Plan Pro o Agency requerido para verificar dominios propios' }
    }

    const { rows: existing } = await db.query(
      'SELECT id FROM domains WHERE user_id = $1 AND domain = $2',
      [userId, domain.toLowerCase()]
    )

    if (existing.length > 0) {
      return { success: false, error: 'Este dominio ya está registrado en tu cuenta' }
    }

    const client  = getSesClient()
    const command = new VerifyDomainDkimCommand({ Domain: domain.toLowerCase() })
    const result  = await client.send(command)
    const dkimTokens = result.DkimTokens || []

    const { rows: inserted } = await db.query(
      `INSERT INTO domains
         (user_id, domain, verified, ses_verification_status, ses_dkim_tokens, verification_attempts, organization_id)
       VALUES ($1, $2, false, 'pending', $3, 0, $4)
       RETURNING *`,
      [userId, domain.toLowerCase(), dkimTokens, organizationId ?? null]
    )

    if (!inserted[0]) {
      return { success: false, error: 'Failed to save domain' }
    }

    return { success: true, domain: inserted[0] as DomainRecord, dkimTokens }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[domain-ses] registerDomain error:', message)
    return { success: false, error: message }
  }
}

export async function verifyDomainStatus(
  userId: string,
  domainId: string
): Promise<{ success: boolean; status?: SesVerificationStatus; error?: string }> {
  try {
    const { rows } = await db.query(
      'SELECT domain, verification_attempts, ses_verification_status FROM domains WHERE id = $1 AND user_id = $2',
      [domainId, userId]
    )
    const domainRecord = rows[0]

    if (!domainRecord) {
      return { success: false, error: 'Domain not found' }
    }

    if (domainRecord.ses_verification_status === 'verified') {
      return { success: true, status: 'verified' }
    }

    const client  = getSesClient()
    const command = new GetIdentityVerificationAttributesCommand({ Identities: [domainRecord.domain] })
    const result  = await client.send(command)

    const attrs     = result.VerificationAttributes?.[domainRecord.domain]
    const awsStatus = attrs?.VerificationStatus

    let newStatus: SesVerificationStatus
    if (awsStatus === 'Success') {
      newStatus = 'verified'
    } else if (awsStatus === 'Failed' || awsStatus === 'TemporaryFailure') {
      newStatus = 'failed'
    } else {
      newStatus = 'pending'
    }

    await db.query(
      `UPDATE domains SET
         ses_verification_status = $1,
         verification_attempts   = verification_attempts + 1,
         ses_verified_at = CASE WHEN $1 = 'verified' THEN NOW() ELSE ses_verified_at END,
         verified        = CASE WHEN $1 = 'verified' THEN true ELSE verified END
       WHERE id = $2`,
      [newStatus, domainId]
    )

    return { success: true, status: newStatus }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[domain-ses] verifyDomainStatus error:', message)
    return { success: false, error: message }
  }
}

export async function revokeDomain(
  userId: string,
  domainId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { rows } = await db.query(
      'SELECT domain FROM domains WHERE id = $1 AND user_id = $2',
      [domainId, userId]
    )
    const domainRecord = rows[0]

    if (!domainRecord) {
      return { success: false, error: 'Domain not found' }
    }

    try {
      const client  = getSesClient()
      const command = new DeleteIdentityCommand({ Identity: domainRecord.domain })
      await client.send(command)
    } catch (sesErr) {
      console.warn('[domain-ses] SES DeleteIdentity failed (continuing):', sesErr)
    }

    await db.query('DELETE FROM domains WHERE id = $1 AND user_id = $2', [domainId, userId])

    clearTransporterCache(domainRecord.domain)

    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[domain-ses] revokeDomain error:', message)
    return { success: false, error: message }
  }
}
