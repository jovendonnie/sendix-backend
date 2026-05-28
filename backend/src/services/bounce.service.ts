import { supabaseAdmin } from '../lib/supabaseAdmin'

export interface SESBounceEvent {
  bounceType: string
  bounceSubType?: string
  bouncedRecipients: Array<{ emailAddress: string; status?: string }>
}

export interface SESComplaintEvent {
  complainedRecipients: Array<{ emailAddress: string }>
  complaintFeedbackType?: string
}

export interface SESMailInfo {
  messageId?: string
  destination?: string[]
}

async function upsertGlobalSuppression(email: string, reason: string): Promise<void> {
  try {
    await supabaseAdmin.from('suppression_list').insert({
      email,
      user_id: null,
      reason,
    })
  } catch {
    // Unique constraint violation = already suppressed, ignore
  }
}

export async function handleBounce(
  bounce: SESBounceEvent,
  mail: SESMailInfo,
  snsMessageId: string,
  rawPayload: unknown
): Promise<void> {
  const isHard = bounce.bounceType === 'Permanent'
  const eventType = isHard ? 'hard_bounce' : 'soft_bounce'

  for (const recipient of bounce.bouncedRecipients) {
    const email = recipient.emailAddress.toLowerCase()

    await supabaseAdmin.from('bounce_events').insert({
      email,
      event_type: eventType,
      bounce_type: bounce.bounceType,
      bounce_subtype: bounce.bounceSubType,
      message_id: mail.messageId ?? null,
      sns_message_id: snsMessageId,
      raw_payload: rawPayload,
    })

    if (isHard) {
      await upsertGlobalSuppression(email, 'hard_bounce')

      if (mail.messageId) {
        await supabaseAdmin
          .from('messages')
          .update({ status: 'bounced', last_bounce_at: new Date().toISOString() })
          .eq('ses_message_id', mail.messageId)
      }
    } else {
      if (mail.messageId) {
        const { data: msg } = await supabaseAdmin
          .from('messages')
          .select('soft_bounce_count')
          .eq('ses_message_id', mail.messageId)
          .maybeSingle()

        const newCount = (msg?.soft_bounce_count ?? 0) + 1

        await supabaseAdmin
          .from('messages')
          .update({ soft_bounce_count: newCount, last_bounce_at: new Date().toISOString() })
          .eq('ses_message_id', mail.messageId)

        if (newCount >= 3) {
          await upsertGlobalSuppression(email, 'soft_bounce_repeated')
        }
      }
    }
  }
}

export async function handleComplaint(
  complaint: SESComplaintEvent,
  mail: SESMailInfo,
  snsMessageId: string,
  rawPayload: unknown
): Promise<void> {
  for (const recipient of complaint.complainedRecipients) {
    const email = recipient.emailAddress.toLowerCase()

    await supabaseAdmin.from('bounce_events').insert({
      email,
      event_type: 'complaint',
      complaint_feedback_type: complaint.complaintFeedbackType,
      message_id: mail.messageId ?? null,
      sns_message_id: snsMessageId,
      raw_payload: rawPayload,
    })

    await upsertGlobalSuppression(email, 'complaint')

    if (mail.messageId) {
      await supabaseAdmin
        .from('messages')
        .update({ status: 'complained' })
        .eq('ses_message_id', mail.messageId)
    }
  }
}

export async function handleDelivery(
  mail: SESMailInfo,
): Promise<void> {
  if (mail.messageId) {
    await supabaseAdmin
      .from('messages')
      .update({ status: 'delivered' })
      .eq('ses_message_id', mail.messageId)
  }
}
