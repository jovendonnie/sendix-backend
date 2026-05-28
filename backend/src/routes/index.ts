import express, { Router, Request, Response } from 'express'
import healthRouter      from './health.route'
import apiKeysRouter     from './apiKeys.route'
import sendRouter        from './send.route'
import v1Router          from './v1/index'
import billingRouter     from './billing.route'
import domainRouter      from './domain.route'
import webhooksSesRouter from './webhooks-ses.route'
import suppressionRouter from './suppression.route'
import bouncesRouter     from './bounces.route'

const router = Router()

// Health routes
router.use('/health', healthRouter)

// API Keys routes
router.use('/api-keys', apiKeysRouter)

// Send routes
router.use('/send', sendRouter)

// Domain routes (register, verify, delete via AWS SES)
router.use('/domains', domainRouter)

// API v1 routes
router.use('/v1', v1Router)

// Billing / Stripe routes
router.use('/billing', billingRouter)

// SNS webhook — public, no authApiKey
router.use('/webhooks/ses', webhooksSesRouter)

// Suppression list (dashboard, authSupabaseUser inside)
router.use('/suppression', suppressionRouter)

// Bounce stats (dashboard, authSupabaseUser inside)
router.use('/bounces', bouncesRouter)

/**
 * GET /api/hello
 * Simple test endpoint
 */
router.get('/hello', (req: Request, res: Response) => {
  res.json({ message: 'Hello from API' })
})

export default router
