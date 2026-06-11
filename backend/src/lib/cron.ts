import { db } from './db'

let _cronTimer: ReturnType<typeof setInterval> | null = null

async function resetMonthlyEmailCounters(): Promise<void> {
  const now = new Date().toISOString()
  console.log(`[cron] Running monthly email counter reset at ${now}`)

  try {
    const result = await db.query(
      `UPDATE profiles
       SET emails_sent_this_month = 0, billing_period_start = $1
       WHERE emails_sent_this_month > 0`,
      [now]
    )
    console.log(`[cron] Reset complete — ${result.rowCount ?? 0} profiles updated`)
  } catch (err) {
    console.error('[cron] Unexpected error during reset:', err)
  }
}

function msUntilNextFirstOfMonth(): number {
  const now  = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return Math.max(next.getTime() - now.getTime(), 0)
}

export function startMonthlyCron(): void {
  if (_cronTimer) {
    console.log('[cron] Monthly cron already running — skipping duplicate start')
    return
  }

  const msUntilFirst = msUntilNextFirstOfMonth()
  const daysUntil    = Math.floor(msUntilFirst / 1000 / 60 / 60 / 24)

  console.log(`[cron] Monthly reset scheduled — first run in ${daysUntil} day(s)`)

  setTimeout(async () => {
    await resetMonthlyEmailCounters()
    _cronTimer = setInterval(resetMonthlyEmailCounters, 30 * 24 * 60 * 60 * 1000)
  }, msUntilFirst)
}

export function stopMonthlyCron(): void {
  if (_cronTimer) {
    clearInterval(_cronTimer)
    _cronTimer = null
    console.log('[cron] Monthly cron stopped')
  }
}

export { resetMonthlyEmailCounters }
