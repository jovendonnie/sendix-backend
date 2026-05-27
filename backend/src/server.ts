import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import apiRoutes from './routes/index'
import v1Routes from './routes/v1'
import { startMonthlyCron } from './lib/cron'

const app = express()
const port = process.env.PORT || 3001

// Request logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`)
  next()
})

// CORS
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(',');
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}))

// Conditional body parsing: raw for Stripe webhook, JSON for everything else
app.use((req, res, next) => {
  if (req.path === '/api/billing/webhook') {
    express.raw({ type: 'application/json' })(req, res, next)
  } else {
    express.json()(req, res, next)
  }
})
app.use(express.urlencoded({ extended: true }))

// Health check
app.get('/', (req, res) => {
  res.json({ message: 'SendIX Backend API', version: '0.1.0' })
})

// Test route
app.get('/test', (req, res) => {
  res.json({ ok: true })
})

// API Routes (prefixed with /api)
app.use('/api', apiRoutes)

// API v1 Routes (prefixed with /api/v1)
app.use('/api/v1', v1Routes)

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message)
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// Start server
app.listen(port, () => {
  console.log(`🚀 Backend running at http://localhost:${port}`)

  // Start the monthly email counter reset cron
  // NOTE: If you're using Supabase pg_cron instead (recommended for production),
  //       comment out this line and set up the cron.schedule() SQL in Supabase.
  startMonthlyCron()
})
