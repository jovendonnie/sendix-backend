-- Migration 3: unsubscribe_tokens
-- Tokens opacos para identificar al destinatario sin exponer su email en la URL

CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
  campaign_id UUID,
  -- Si aplica, para saber de qué campaña se dio de baja
  used_at     TIMESTAMPTZ,
  -- NULL = no usado aún, TIMESTAMPTZ = fecha en que el usuario se dio de baja
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 year',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unsubscribe_token ON unsubscribe_tokens(token);
CREATE INDEX IF NOT EXISTS idx_unsubscribe_email ON unsubscribe_tokens(email, user_id);
