import { db } from './db'

let _started = false
let _cronTimer: ReturnType<typeof setInterval> | null = null

async function resetMonthlyEmailCounters(): Promise<void> {
  const now = new Date()
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  console.log(`[cron] Running monthly email counter reset at ${now.toISOString()}`)

  try {
    // Only reset profiles whose billing_period_start is from a previous month
    const result = await db.query(
      `UPDATE profiles
       SET emails_sent_this_month = 0, billing_period_start = $1
       WHERE emails_sent_this_month > 0
         AND (billing_period_start IS NULL OR to_char(billing_period_start, 'YYYY-MM') < $2)`,
      [now.toISOString(), currentMonth]
    )
    console.log(`[cron] Reset complete — ${result.rowCount ?? 0} profiles updated`)
  } catch (err) {
    console.error('[cron] Unexpected error during reset:', err)
  }
}

function msUntilNextFirstOfMonth(): number {
  const now  = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return Math.max(next.getTime() - now.getTime(), 60_000)
}

function scheduleNextRun(): void {
  const msUntilFirst = msUntilNextFirstOfMonth()
  const daysUntil    = Math.floor(msUntilFirst / 1000 / 60 / 60 / 24)
  console.log(`[cron] Next monthly reset in ${daysUntil} day(s)`)

  _cronTimer = setTimeout(async () => {
    _cronTimer = null
    await resetMonthlyEmailCounters()
    scheduleNextRun()
  }, msUntilFirst) as unknown as ReturnType<typeof setInterval>
}

export function startMonthlyCron(): void {
  if (_started) {
    console.log('[cron] Monthly cron already running — skipping duplicate start')
    return
  }
  _started = true
  scheduleNextRun()
}

export function stopMonthlyCron(): void {
  if (_cronTimer) {
    clearTimeout(_cronTimer as unknown as ReturnType<typeof setTimeout>)
    _cronTimer = null
    _started = false
    console.log('[cron] Monthly cron stopped')
  }
}

export { resetMonthlyEmailCounters }
