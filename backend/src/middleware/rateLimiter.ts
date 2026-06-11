import rateLimit from 'express-rate-limit'

// Uses req.ip which respects the `trust proxy` setting configured in server.ts.
// Do NOT extract IP from x-forwarded-for manually — it is client-controlled when trust proxy is off.

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
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
  message: {
    error: 'Too many requests from this IP. Try again in 15 minutes.',
    code: 'RATE_LIMIT_API',
  },
})
