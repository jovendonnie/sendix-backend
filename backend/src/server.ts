import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import apiRoutes from './routes/index'
import v1Routes from './routes/v1'
import unsubscribeRouter from './routes/unsubscribe.route'
import clerkWebhookRouter from './routes/webhooks-clerk.route'
import { startMonthlyCron } from './lib/cron'
import { apiRateLimiter, authRateLimiter } from './middleware/rateLimiter'

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

// Conditional body parsing
// - Stripe webhook:  raw buffer (signature verification)
// - Clerk webhook:   raw buffer (svix signature verification)
// - SNS webhook:     text (SNS sends JSON with Content-Type: text/plain)
// - Everything else: JSON
app.use((req, res, next) => {
  if (req.path === '/api/billing/webhook') {
    express.raw({ type: 'application/json' })(req, res, next)
  } else if (req.path === '/api/webhooks/clerk') {
    express.raw({ type: 'application/json' })(req, res, next)
  } else if (req.path === '/api/webhooks/ses' || req.path.startsWith('/api/webhooks/ingest/')) {
    // SNS and provider ingest webhooks may arrive as text/plain or application/json
    express.text({ type: '*/*' })(req, res, (err) => {
      if (err) return next(err)
      // Try to parse text body as JSON for ingest route
      if (typeof req.body === 'string') {
        try { (req as any).body = JSON.parse(req.body) } catch { /* keep raw string */ }
      }
      next()
    })
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

// Unsubscribe — public, no auth, must be before /api to avoid conflicts
app.use('/unsubscribe', unsubscribeRouter)

// Clerk webhook — public (signature-verified), raw body already parsed above
app.use('/api/webhooks/clerk', clerkWebhookRouter)

// Rate limiting — auth endpoints: 10 req/15min per IP
// Covers login, register, and password-reset token flows
app.use('/api/auth', authRateLimiter)

// Rate limiting — general API: 200 req/15min per IP
app.use('/api', apiRateLimiter)
app.use('/api/v1', apiRateLimiter)

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
