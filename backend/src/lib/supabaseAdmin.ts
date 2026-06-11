import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)')
    _client = createClient(url, key)
  }
  return _client
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get: (_target, prop: string | symbol) => getClient()[prop as keyof SupabaseClient],
})
