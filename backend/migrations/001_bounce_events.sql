-- Migration 1: bounce_events
-- Registro de auditoría de cada evento recibido de SES/SNS

CREATE TABLE IF NOT EXISTS bounce_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                   TEXT NOT NULL,
  event_type              TEXT NOT NULL,
  -- 'hard_bounce' | 'soft_bounce' | 'complaint' | 'delivery'
  bounce_type             TEXT,
  -- Para bounces: 'Permanent' | 'Transient' | 'Undetermined'
  bounce_subtype          TEXT,
  -- Para quejas: 'abuse' | 'auth-failure' | 'fraud' | 'not-spam' | 'other' | 'virus'
  complaint_feedback_type TEXT,
  message_id              TEXT,
  -- El Message-ID del correo que generó el evento
  sns_message_id          TEXT,
  -- ID único del mensaje SNS, para deduplicación
  raw_payload             JSONB,
  -- El payload completo de SNS para auditoría
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bounce_events_email  ON bounce_events(email);
CREATE INDEX IF NOT EXISTS idx_bounce_events_type   ON bounce_events(event_type, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bounce_events_sns_id ON bounce_events(sns_message_id);
-- El índice único en sns_message_id previene procesar el mismo evento dos veces
