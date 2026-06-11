-- Migration 008: Remove raw_key column from api_keys
-- The raw_key column stored API keys in plaintext — a critical security vulnerability.
-- After running migration 006, key_prefix contains the first 16 chars (non-secret, used for lookup).
-- The full key is only shown once to the user at creation time and is never stored again.
-- Safe to run multiple times (IF EXISTS).

-- Verify key_prefix is populated before dropping raw_key
DO $$
DECLARE
  unprefixed_count INT;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'raw_key'
  ) THEN
    SELECT COUNT(*) INTO unprefixed_count
    FROM api_keys
    WHERE key_prefix IS NULL AND revoked = false;

    IF unprefixed_count > 0 THEN
      RAISE EXCEPTION
        'Cannot drop raw_key: % active keys have NULL key_prefix. Run migration 006 first.',
        unprefixed_count;
    END IF;

    ALTER TABLE api_keys DROP COLUMN raw_key;
    RAISE NOTICE 'raw_key column removed from api_keys.';
  ELSE
    RAISE NOTICE 'raw_key column does not exist — nothing to do.';
  END IF;
END;
$$;
