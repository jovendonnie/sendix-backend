import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import type { Request } from 'express'

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0] ?? req.ip ?? ''
  return ipKeyGenerator(raw.trim())
}

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  message: {
    error: 'Too many auth requests from this IP. Try again in 15 minutes.',
    code: 'RATE_LIMIT_AUTH',
  },
  skip: (req) => req.method === 'GET',
})

export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  message: {
    error: 'Too many requests from this IP. Try again in 15 minutes.',
    code: 'RATE_LIMIT_API',
  },
})
