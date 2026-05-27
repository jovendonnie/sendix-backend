import { SESClient } from '@aws-sdk/client-ses'

let _sesClient: SESClient | null = null

/**
 * Returns the singleton AWS SES SDK client.
 * Used for domain management (verify/delete identities) — NOT for SMTP sending.
 * Throws at call time if credentials are missing.
 */
export function getSesClient(): SESClient {
  if (_sesClient) return _sesClient

  const region = process.env.AWS_REGION || 'us-east-1'
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the backend .env file.'
    )
  }

  _sesClient = new SESClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  })

  console.log(`[ses-client] Initialized for region: ${region}`)
  return _sesClient
}

/** Reset the singleton (useful in tests). */
export function resetSesClient(): void {
  if (_sesClient) {
    _sesClient.destroy()
    _sesClient = null
  }
}