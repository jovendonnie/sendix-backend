-- Migration 5: Add ses_message_id to messages
-- Links a message record to the SES-assigned Message-ID so that
-- SNS delivery/bounce notifications can update the correct row.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ses_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_ses_message_id
  ON messages(ses_message_id) WHERE ses_message_id IS NOT NULL;
