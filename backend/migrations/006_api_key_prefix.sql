-- Migration 006: Add key_prefix column and index to api_keys
-- This enables O(1) key lookups instead of full table scans.
-- Safe to run multiple times (all statements are idempotent).

-- 1. Add the column if it doesn't exist yet
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS key_prefix VARCHAR(16);

-- 2. Partial index on key_prefix for active keys — the lookup used in authApiKey middleware
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix
  ON api_keys(key_prefix)
  WHERE revoked = false;

-- 3. Backfill key_prefix from raw_key for existing rows created before this migration.
--    Only runs if the raw_key column still exists (old Supabase schema).
--    If raw_key was already removed, this block is a safe no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'raw_key'
  ) THEN
    UPDATE api_keys
    SET key_prefix = LEFT(raw_key, 16)
    WHERE key_prefix IS NULL AND raw_key IS NOT NULL;

    RAISE NOTICE 'Backfilled key_prefix from raw_key for % rows.',
      (SELECT COUNT(*) FROM api_keys WHERE key_prefix IS NOT NULL);
  ELSE
    RAISE NOTICE 'raw_key column does not exist — no backfill needed.';
  END IF;
END;
$$;
