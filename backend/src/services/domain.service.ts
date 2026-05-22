import { supabaseAdmin } from '../lib/supabaseAdmin'

export interface Domain {
  id: string
  user_id: string
  domain: string
  verified: boolean
  created_at: string
}

const DEFAULT_FROM = process.env.EMAIL_FROM || 'SendIX <onboarding@resend.dev>'

export function extractDomain(email: string): string | null {
  if (!email || !email.includes('@')) return null
  const parts = email.split('@')
  return parts[1]?.toLowerCase() || null
}

function isValidDomain(domain: string): boolean {
  const domainRegex = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/
  return domainRegex.test(domain.toLowerCase())
}

export async function createDomain(userId: string, domain: string): Promise<{ success: boolean; error?: string; domain?: Domain }> {
  const normalizedDomain = domain.toLowerCase().trim()

  if (!isValidDomain(normalizedDomain)) {
    return { success: false, error: 'Invalid domain format' }
  }

  const { data: existing } = await supabaseAdmin
    .from('domains')
    .select('id')
    .eq('user_id', userId)
    .eq('domain', normalizedDomain)
    .single()

  if (existing) {
    return { success: false, error: 'Domain already exists' }
  }

  const { data, error } = await supabaseAdmin
    .from('domains')
    .insert({ user_id: userId, domain: normalizedDomain, verified: true })
    .select()
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, domain: data }
}

export async function getUserDomains(userId: string): Promise<Domain[]> {
  const { data, error } = await supabaseAdmin
    .from('domains')
    .select('id, user_id, domain, verified, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return data || []
}

async function checkDomain(userId: string, domain: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('domains')
    .select('id')
    .eq('user_id', userId)
    .eq('domain', domain.toLowerCase())
    .eq('verified', true)
    .single()

  if (error || !data) return false
  return true
}

export function getDefaultSender(): string {
  return DEFAULT_FROM
}

export function shouldUseFallback(userId: string, fromEmail: string): Promise<{ fallback: boolean; from: string }> {
  return resolveSender(userId, fromEmail)
}

async function resolveSender(userId: string, fromEmail: string): Promise<{ fallback: boolean; from: string }> {
  if (!fromEmail) {
    return { fallback: true, from: DEFAULT_FROM }
  }

  const domain = extractDomain(fromEmail)
  if (!domain) {
    return { fallback: true, from: DEFAULT_FROM }
  }

  const allowed = await checkDomain(userId, domain)
  if (!allowed) {
    return { fallback: true, from: DEFAULT_FROM }
  }

  return { fallback: false, from: fromEmail }
}

export const domainService = {
  extractDomain,
  createDomain,
  getUserDomains,
  isDomainAllowed: (userId: string, domain: string) => checkDomain(userId, domain),
  getDefaultSender,
  shouldUseFallback
}