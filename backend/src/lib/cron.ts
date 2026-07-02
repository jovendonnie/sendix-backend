import { db } from './db'

let _started = false
let _cronTimer: ReturnType<typeof setInterval> | null = null
let _lastResetMonth = ''

async function resetMonthlyEmailCounters(): Promise<void> {
  const now = new Date()
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  console.log(`[cron] Running monthly email counter reset at ${now.toISOString()}`)

  try {
    const result = await db.query(
      `UPDATE profiles
       SET emails_sent_this_month = 0, billing_period_start = $1
       WHERE emails_sent_this_month > 0
         AND (billing_period_start IS NULL OR to_char(billing_period_start, 'YYYY-MM') < $2)`,
      [now.toISOString(), currentMonth]
    )
    _lastResetMonth = currentMonth
    console.log(`[cron] Reset complete — ${result.rowCount ?? 0} profiles updated`)
  } catch (err) {
    console.error('[cron] Unexpected error during reset:', err)
  }
}

// Polls every hour — avoids the 32-bit setTimeout overflow (~24.8 day limit)
async function tick(): Promise<void> {
  const now = new Date()
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

  if (now.getUTCDate() === 1 && _lastResetMonth !== currentMonth) {
    await resetMonthlyEmailCounters()
  }
}

export function startMonthlyCron(): void {
  if (_started) {
    console.log('[cron] Monthly cron already running — skipping duplicate start')
    return
  }
  _started = true

  const now = new Date()
  const daysUntil = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).getDate() - now.getUTCDate()
  console.log(`[cron] Monthly reset polling started — next 1st of month in ~${daysUntil} day(s)`)

  _cronTimer = setInterval(tick, 60 * 60 * 1_000) // check every hour
}

export function stopMonthlyCron(): void {
  if (_cronTimer) {
    clearInterval(_cronTimer)
    _cronTimer = null
    _started = false
    console.log('[cron] Monthly cron stopped')
  }
}

export { resetMonthlyEmailCounters }
