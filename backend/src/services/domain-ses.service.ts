import {
  VerifyDomainDkimCommand,
  GetIdentityVerificationAttributesCommand,
  DeleteIdentityCommand,
} from '@aws-sdk/client-ses'
import { getSesClient } from '../lib/ses-client'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { clearTransporterCache } from '../lib/smtp'

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── PASO 1: Registrar dominio ─────────────────────────────────────────────────

/**
 * POST /api/domains
 *
 * Calls SES `VerifyDomainDkim`, stores the 3 CNAME tokens in `domains`,
 * and returns them so the frontend can display them to the user.
 *
 * Only Pro / Agency plans can register their own domains.
 */
export async function registerDomain(
  userId: string,
  domain: string,
  organizationId?: string
): Promise<{ success: boolean; domain?: DomainRecord; dkimTokens?: string[]; error?: string }> {
  try {
    // ── Plan gate ──────────────────────────────────────────────────────────────
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single()

    const plan = profile?.plan || 'free'
    if (!['pro', 'agency'].includes(plan)) {
      return {
        success: false,
        error: 'Plan Pro o Agency requerido para verificar dominios propios',
      }
    }

    // ── Duplicate check ────────────────────────────────────────────────────────
    const { data: existing } = await supabaseAdmin
      .from('domains')
      .select('id')
      .eq('user_id', userId)
      .eq('domain', domain.toLowerCase())
      .maybeSingle()

    if (existing) {
      return { success: false, error: 'Este dominio ya está registrado en tu cuenta' }
    }

    // ── Call AWS SES ───────────────────────────────────────────────────────────
    const client  = getSesClient()
    const command = new VerifyDomainDkimCommand({ Domain: domain.toLowerCase() })
    const result  = await client.send(command)

    const dkimTokens = result.DkimTokens || []

    // ── Persist in Supabase ────────────────────────────────────────────────────
    const insertPayload: Record<string, unknown> = {
      user_id:                  userId,
      domain:                   domain.toLowerCase(),
      verified:                 false,
      ses_verification_status:  'pending',
      ses_dkim_tokens:          dkimTokens,
      verification_attempts:    0,
    }
    if (organizationId) insertPayload.organization_id = organizationId

    const { data: domainRecord, error: insertError } = await supabaseAdmin
      .from('domains')
      .insert(insertPayload)
      .select()
      .single()

    if (insertError || !domainRecord) {
      return { success: false, error: insertError?.message || 'Failed to save domain' }
    }

    return { success: true, domain: domainRecord as DomainRecord, dkimTokens }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[domain-ses] registerDomain error:', message)
    return { success: false, error: message }
  }
}

// ─── PASO 2: Verificar estado ──────────────────────────────────────────────────

/**
 * POST /api/domains/:id/verify
 *
 * Asks SES for the current verification status of the domain.
 * Updates `domains.ses_verification_status` and increments `verification_attempts`.
 */
export async function verifyDomainStatus(
  userId: string,
  domainId: string
): Promise<{ success: boolean; status?: SesVerificationStatus; error?: string }> {
  try {
    const { data: domainRecord, error: fetchError } = await supabaseAdmin
      .from('domains')
      .select('domain, verification_attempts, ses_verification_status')
      .eq('id', domainId)
      .eq('user_id', userId)
      .single()

    if (fetchError || !domainRecord) {
      return { success: false, error: 'Domain not found' }
    }

    // If already verified, short-circuit
    if (domainRecord.ses_verification_status === 'verified') {
      return { success: true, status: 'verified' }
    }

    // ── Call AWS SES ───────────────────────────────────────────────────────────
    const client  = getSesClient()
    const command = new GetIdentityVerificationAttributesCommand({
      Identities: [domainRecord.domain],
    })
    const result = await client.send(command)

    const attrs     = result.VerificationAttributes?.[domainRecord.domain]
    const awsStatus = attrs?.VerificationStatus  // 'Pending' | 'Success' | 'Failed' | 'TemporaryFailure' | 'NotStarted'

    let newStatus: SesVerificationStatus
    if (awsStatus === 'Success') {
      newStatus = 'verified'
    } else if (awsStatus === 'Failed' || awsStatus === 'TemporaryFailure') {
      newStatus = 'failed'
    } else {
      newStatus = 'pending'
    }

    // ── Update DB ──────────────────────────────────────────────────────────────
    const updatePayload: Record<string, unknown> = {
      ses_verification_status: newStatus,
      verification_attempts:   (domainRecord.verification_attempts || 0) + 1,
    }
    if (newStatus === 'verified') {
      updatePayload.ses_verified_at = new Date().toISOString()
      updatePayload.verified        = true
    }

    await supabaseAdmin
      .from('domains')
      .update(updatePayload)
      .eq('id', domainId)

    return { success: true, status: newStatus }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[domain-ses] verifyDomainStatus error:', message)
    return { success: false, error: message }
  }
}

// ─── PASO 3: Revocar dominio ───────────────────────────────────────────────────

/**
 * DELETE /api/domains/:id
 *
 * Deletes the SES identity, clears the SMTP transporter cache,
 * and marks the domain record as `not_started` (soft delete from SES perspective).
 * The Supabase row is fully removed.
 */
export async function revokeDomain(
  userId: string,
  domainId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: domainRecord, error: fetchError } = await supabaseAdmin
      .from('domains')
      .select('domain')
      .eq('id', domainId)
      .eq('user_id', userId)
      .single()

    if (fetchError || !domainRecord) {
      return { success: false, error: 'Domain not found' }
    }

    // ── Remove from AWS SES (best-effort) ──────────────────────────────────────
    try {
      const client  = getSesClient()
      const command = new DeleteIdentityCommand({ Identity: domainRecord.domain })
      await client.send(command)
    } catch (sesErr) {
      // Log but continue — even if SES call fails we want to clean our DB
      console.warn('[domain-ses] SES DeleteIdentity failed (continuing):', sesErr)
    }

    // ── Delete row from Supabase ───────────────────────────────────────────────
    const { error: deleteError } = await supabaseAdmin
      .from('domains')
      .delete()
      .eq('id', domainId)
      .eq('user_id', userId)

    if (deleteError) {
      return { success: false, error: deleteError.message }
    }

    // ── Invalidate SMTP transporter cache ──────────────────────────────────────
    clearTransporterCache(domainRecord.domain)

    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[domain-ses] revokeDomain error:', message)
    return { success: false, error: message }
  }
}
