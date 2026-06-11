-- Migration 007: Atomic email counter increment function
-- Replaces the 2-query SELECT + UPDATE pattern with a single atomic UPDATE.
-- This was the direct cause of the 07:22:04 incident (200 concurrent PATCH /profiles → 522 cascade).
-- Safe to run multiple times (CREATE OR REPLACE).

-- The backend calls this via:
--   db.query('SELECT increment_email_counter($1, $2)', [userId, count])
-- Falls back to a direct UPDATE if the function is not yet deployed.

CREATE OR REPLACE FUNCTION increment_email_counter(p_user_id TEXT, p_count INT DEFAULT 1)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE profiles
  SET emails_sent_this_month = COALESCE(emails_sent_this_month, 0) + p_count
  WHERE id = p_user_id;
$$;

-- Overload for UUID-typed user IDs (legacy Supabase schema where profiles.id was UUID)
CREATE OR REPLACE FUNCTION increment_email_counter(p_user_id UUID, p_count INT DEFAULT 1)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE profiles
  SET emails_sent_this_month = COALESCE(emails_sent_this_month, 0) + p_count
  WHERE id = p_user_id::TEXT;
$$;
