import express, { Router, Request, Response } from 'express'
import { authClerkUser, UserRequest } from '../middleware/authClerkUser'
import healthRouter       from './health.route'
import apiKeysRouter      from './apiKeys.route'
import sendRouter         from './send.route'
import v1Router           from './v1/index'
import billingRouter      from './billing.route'
import domainRouter       from './domain.route'
import webhooksSesRouter  from './webhooks-ses.route'
import suppressionRouter  from './suppression.route'
import bouncesRouter      from './bounces.route'
import dashboardRouter    from './dashboard.route'
import providersRouter    from './providers.route'
import eventsRouter       from './events.route'
import webhooksIngestRouter from './webhooks-ingest.route'

const router = Router()

// Health routes
router.use('/health', healthRouter)

// API Keys routes
router.use('/api-keys', apiKeysRouter)

// Send routes (orchestrated)
router.use('/send', sendRouter)

// Domain routes (register, verify, delete via AWS SES)
router.use('/domains', domainRouter)

// API v1 routes
router.use('/v1', v1Router)

// Billing / Stripe routes
router.use('/billing', billingRouter)

// SNS webhook — public, no authApiKey
router.use('/webhooks/ses', webhooksSesRouter)

// Provider webhook ingest — public, routes by userId
router.use('/webhooks/ingest', webhooksIngestRouter)

// Suppression list (dashboard, authClerkUser inside)
router.use('/suppression', suppressionRouter)

// Bounce stats (dashboard, authClerkUser inside)
router.use('/bounces', bouncesRouter)

// Dashboard endpoints — Clerk JWT auth, for dashboard pages
router.use('/dashboard', dashboardRouter)

// Providers management (Clerk JWT auth)
router.use('/providers', providersRouter)

// Events (normalized, Clerk JWT auth)
router.use('/events', eventsRouter)

// User sync — called by frontend on login to ensure profiles row exists
router.post('/users/sync', authClerkUser, (req: UserRequest, res: Response) => {
  res.json({ ok: true, userId: req.userId })
})

/**
 * GET /api/hello
 * Simple test endpoint
 */
router.get('/hello', (req: Request, res: Response) => {
  res.json({ message: 'Hello from API' })
})

export default router
