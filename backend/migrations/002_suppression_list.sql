-- Migration 2: suppression_list
-- Lista global de emails que no deben recibir correos

CREATE TABLE IF NOT EXISTS suppression_list (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  user_id    UUID REFERENCES profiles(id) ON DELETE CASCADE,
  -- NULL = supresión global de la plataforma (hard bounce, complaint)
  -- UUID = supresión solo para ese usuario (unsubscribe de sus campañas)
  reason     TEXT NOT NULL,
  -- 'hard_bounce' | 'soft_bounce_repeated' | 'complaint' | 'unsubscribed' | 'manual'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice parcial para supresiones globales (user_id IS NULL) — garantiza un solo registro por email global
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_global_email
  ON suppression_list(email) WHERE user_id IS NULL;

-- Índice para supresiones por usuario
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_user_email
  ON suppression_list(email, user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_suppression_email ON suppression_list(email);
CREATE INDEX IF NOT EXISTS idx_suppression_user  ON suppression_list(user_id);

-- RLS: un usuario solo puede ver su propia suppression list y las globales
ALTER TABLE suppression_list ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own suppressions" ON suppression_list
  FOR SELECT USING (
    auth.uid() = user_id OR user_id IS NULL
  );

-- Política para operaciones DELETE del usuario (solo puede borrar las suyas, no las globales)
CREATE POLICY "Users delete own suppressions" ON suppression_list
  FOR DELETE USING (
    auth.uid() = user_id
  );

-- El service_role del backend tiene acceso completo (omite RLS por defecto)
