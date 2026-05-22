import { supabaseAdmin } from '../lib/supabaseAdmin'
import { sendEmail, SendEmailResult } from '../lib/resend'
import { domainService, shouldUseFallback } from './domain.service'

export interface MessageLog {
  id?: string
  user_id: string
  api_key_id: string
  to_email: string
  from_email?: string
  subject: string
  text?: string
  html?: string
  status: 'sent' | 'failed'
  fallback_used?: boolean
  response?: object
  created_at?: string
}

export interface SendEmailInput {
  to_email: string
  from_email?: string
  subject: string
  text?: string
  html?: string
}

export interface ValidationError {
  field: string
  message: string
}

export function validateEmailInput(input: SendEmailInput): ValidationError[] {
  const errors: ValidationError[] = []

  if (!input.to_email || typeof input.to_email !== 'string' || input.to_email.trim() === '') {
    errors.push({ field: 'to_email', message: 'to_email is required' })
  } else if (!isValidEmail(input.to_email)) {
    errors.push({ field: 'to_email', message: 'Invalid email format' })
  }

  if (!input.subject || typeof input.subject !== 'string' || input.subject.trim() === '') {
    errors.push({ field: 'subject', message: 'subject is required' })
  }

  const hasText = input.text && input.text.trim() !== ''
  const hasHtml = input.html && input.html.trim() !== ''

  if (!hasText && !hasHtml) {
    errors.push({ field: 'content', message: 'At least one of text or html must be provided' })
  }

  if (input.from_email && !isValidEmail(input.from_email)) {
    errors.push({ field: 'from_email', message: 'Invalid email format' })
  }

  return errors
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

async function validateApiKey(rawKey: string): Promise<{ valid: boolean; userId?: string; keyId?: string }> {
  const result = await import('./apiKey.service').then(m => m.apiKeyService.validateApiKey(rawKey))
  
  if (!result) {
    return { valid: false }
  }

  return { valid: true, userId: result.user_id, keyId: result.id }
}

async function sendEmailWithLogging(
  input: SendEmailInput,
  userId: string,
  apiKeyId: string
): Promise<{ status: 'sent' | 'failed'; error?: string }> {
  const sender = await shouldUseFallback(userId, input.from_email || '')

  const sendResult: SendEmailResult = await sendEmail({
    to: input.to_email,
    from: sender.from,
    subject: input.subject,
    text: input.text,
    html: input.html
  })

  const logData: MessageLog = {
    user_id: userId,
    api_key_id: apiKeyId,
    to_email: input.to_email,
    from_email: sender.from,
    subject: input.subject,
    text: input.text || undefined,
    html: input.html || undefined,
    status: sendResult.success ? 'sent' : 'failed',
    fallback_used: sender.fallback,
    response: sendResult.success ? (sendResult.data || {}) : { error: sendResult.error }
  }

  try {
    await logMessage(logData)
  } catch (logError) {
    console.error('Failed to log message:', logError)
  }

  return {
    status: sendResult.success ? 'sent' : 'failed',
    error: sendResult.error
  }
}

async function logMessage(log: MessageLog): Promise<MessageLog> {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert(log)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export const messageService = {
  validateEmailInput,
  validateApiKey,
  sendEmailWithLogging,
  logMessage
}