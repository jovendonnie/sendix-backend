-- Migration 4: campos de soft bounce tracking en messages

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS soft_bounce_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_bounce_at    TIMESTAMPTZ;
