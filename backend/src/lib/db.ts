import { Pool } from 'pg'

const connectionString = process.env.DATABASE_URL ?? ''

// Neon requires SSL. If the URL already has sslmode=require we let pg-connection-string
// handle it; otherwise we force it via the ssl object.
const needsSslObject = !connectionString.includes('sslmode=')

export const db = new Pool({
  connectionString,
  ...(needsSslObject ? { ssl: { rejectUnauthorized: false } } : {}),
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,  // 15s — Neon serverless cold start can be slow
})

db.query('SELECT 1').then(() => {
  console.log('[db] Neon connection OK')
}).catch(err => {
  console.error('[db] Neon connection FAILED:', err.message)
  process.exit(1)
})
