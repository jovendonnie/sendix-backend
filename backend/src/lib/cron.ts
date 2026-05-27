import { supabaseAdmin } from './supabaseAdmin'

/**
 * Monthly email counter reset.
 *
 * Resets `profiles.emails_sent_this_month` to 0 for all users on the 1st of each month.
 *
 * Two scheduling approaches are supported (pick one in server.ts):
 *
 *   A) startMonthlyCron()  — runs inside the Express process using setTimeout/setInterval.
 *      Simple, no extra dependencies. Timer resets on Railway restarts (next fire
 *      will be the 1st of the next month after restart — acceptable).
 *
 *   B) Supabase pg_cron (recommended for production) — zero dependency on the
 *      backend process. See the SQL snippet at the bottom of this file.
 */

let _cronTimer: ReturnType<typeof setInterval> | null = null

// ─── Core reset logic ─────────────────────────────────────────────────────────

async function resetMonthlyEmailCounters(): Promise<void> {
  const now = new Date().toISOString()
  console.log(`[cron] Running monthly email counter reset at ${now}`)

  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({
        emails_sent_this_month: 0,
        billing_period_start:   now,
      })
      .gt('emails_sent_this_month', 0) // only touch rows that actually need resetting
      .select('id')

    if (error) {
      console.error('[cron] Reset failed:', error.message)
      return
    }

    console.log(`[cron] Reset complete — ${data?.length ?? 0} profiles updated`)
  } catch (err) {
    console.error('[cron] Unexpected error during reset:', err)
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Calculate milliseconds until the next 1st of the month at 00:00:00 UTC.
 */
function msUntilNextFirstOfMonth(): number {
  const now  = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return Math.max(next.getTime() - now.getTime(), 0)
}

/**
 * Start the in-process monthly cron.
 * Call once from server.ts on startup.
 */
export function startMonthlyCron(): void {
  if (_cronTimer) {
    console.log('[cron] Monthly cron already running — skipping duplicate start')
    return
  }

  const msUntilFirst = msUntilNextFirstOfMonth()
  const daysUntil    = Math.floor(msUntilFirst / 1000 / 60 / 60 / 24)

  console.log(`[cron] Monthly reset scheduled — first run in ${daysUntil} day(s)`)

  // First run: fire exactly at 1st of next month
  setTimeout(async () => {
    await resetMonthlyEmailCounters()

    // Repeat every ~30 days thereafter
    _cronTimer = setInterval(resetMonthlyEmailCounters, 30 * 24 * 60 * 60 * 1000)
  }, msUntilFirst)
}

/**
 * Stop the in-process cron (useful in tests or graceful shutdown).
 */
export function stopMonthlyCron(): void {
  if (_cronTimer) {
    clearInterval(_cronTimer)
    _cronTimer = null
    console.log('[cron] Monthly cron stopped')
  }
}

/**
 * Run the reset immediately — useful for manual triggering or testing.
 */
export { resetMonthlyEmailCounters }

/*
────────────────────────────────────────────────────────────────────────────────
ALTERNATIVE: Supabase pg_cron (recommended for production)
Run this SQL once in the Supabase SQL Editor after enabling the pg_cron extension:

  -- 1. Enable extension (Extensions tab in Supabase dashboard)
  -- CREATE EXTENSION IF NOT EXISTS pg_cron;

  -- 2. Schedule the job
  SELECT cron.schedule(
    'reset-monthly-email-counters',
    '0 0 1 * *',  -- At 00:00 on the 1st of every month (UTC)
    $$
      UPDATE profiles
      SET emails_sent_this_month = 0,
          billing_period_start   = NOW()
      WHERE emails_sent_this_month > 0;
    $$
  );

  -- 3. Verify it's registered
  SELECT * FROM cron.job;

If using pg_cron, do NOT call startMonthlyCron() in server.ts.
────────────────────────────────────────────────────────────────────────────────
*/
