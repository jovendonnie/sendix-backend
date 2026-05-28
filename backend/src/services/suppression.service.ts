import { supabaseAdmin } from '../lib/supabaseAdmin'

export async function isEmailSuppressed(
  email: string,
  userId: string
): Promise<{ suppressed: boolean; reason?: string }> {
  const normalized = email.toLowerCase().trim()

  const { data } = await supabaseAdmin
    .from('suppression_list')
    .select('id, reason')
    .eq('email', normalized)
    .or(`user_id.eq.${userId},user_id.is.null`)
    .limit(1)
    .maybeSingle()

  if (data) return { suppressed: true, reason: data.reason }
  return { suppressed: false }
}

export async function filterSuppressedEmails(
  emails: string[],
  userId: string
): Promise<{
  toSend: string[]
  suppressed: Array<{ email: string; reason: string }>
}> {
  if (emails.length === 0) return { toSend: [], suppressed: [] }

  const normalized = emails.map(e => e.toLowerCase().trim())

  const { data: suppressedRows } = await supabaseAdmin
    .from('suppression_list')
    .select('email, reason')
    .in('email', normalized)
    .or(`user_id.eq.${userId},user_id.is.null`)

  const suppressedMap = new Map<string, string>()
  for (const row of suppressedRows || []) {
    suppressedMap.set(row.email, row.reason)
  }

  const toSend: string[] = []
  const suppressed: Array<{ email: string; reason: string }> = []

  for (const email of normalized) {
    if (suppressedMap.has(email)) {
      suppressed.push({ email, reason: suppressedMap.get(email)! })
    } else {
      toSend.push(email)
    }
  }

  return { toSend, suppressed }
}
