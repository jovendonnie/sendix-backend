import express from 'express'
import emailsRouter from './emails.route'
import webhooksRouter from './webhooks.route'
import healthRouter from './health.route'

const router = express.Router()

// Health check for v1
router.use('/health', healthRouter)

// Email endpoints
router.use('/emails', emailsRouter)

// Webhook endpoints
router.use('/webhooks', webhooksRouter)

export default router
