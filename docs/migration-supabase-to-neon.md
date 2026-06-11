# Migración completa: Supabase → Neon + Clerk

**Última actualización:** 2026-06-09  
**Objetivo:** Eliminar Supabase completamente — DB a Neon (desde cero), Auth a Clerk  
**Estado actual:** ✅ **MIGRACIÓN COMPLETA** — backend y frontend migrados, pendiente solo deploy (env vars + migration 009 en Neon)

---

## Índice

1. [Qué tiene Supabase que debes trasladar](#1-inventario)
2. [Plan de migración](#2-plan-de-migración)
3. [Exportar configuración de OAuth de Supabase](#3-exportar-configuración-de-oauth-de-supabase)
4. [Crear proyecto en Neon](#4-crear-proyecto-en-neon)
5. [SQL completo — schema en Neon](#5-sql-completo--schema-en-neon) ✅ Hecho
6. [Migración 009 — Fix de IDs para Clerk](#6-migración-009--fix-de-ids-para-clerk) ⚠️ Pendiente ejecutar en Neon
7. [Verificar que el schema está correcto](#7-verificar-que-el-schema-está-correcto)
8. [Configurar Clerk — Auth + OAuth](#8-configurar-clerk--auth--oauth) ✅ Hecho
9. [Cambios en el backend](#9-cambios-en-el-backend) ✅ Hecho
10. [Cambios en el frontend](#10-cambios-en-el-frontend) ✅ Hecho
11. [Variables de entorno](#11-variables-de-entorno)
12. [Validación en staging](#12-validación-en-staging)
13. [Cutover a producción](#13-cutover-a-producción)
14. [Checklist completo](#14-checklist-completo)

---

## 1. Inventario

Todo lo que Supabase provee y adónde va:

| Capa | En Supabase | Destino |
|------|-------------|---------|
| Base de datos | PostgreSQL | → **Neon** ✅ schema creado |
| Auth email/password | Supabase Auth | → **Clerk** ✅ |
| OAuth Google | Supabase maneja el callback | → **Clerk** ✅ |
| OAuth GitHub | Supabase maneja el callback | → **Clerk** ✅ |
| Sesiones / JWT | Tokens de Supabase | → **Clerk** genera sus propios JWT ✅ |
| Trigger `profiles` | Se creaba al registrar usuario | → Webhook de Clerk ✅ |
| Políticas RLS | `auth.uid()` de Supabase | → Eliminadas; el backend autoriza por `user_id` ✅ |

---

## 2. Plan de migración

```
Supabase Auth  →  Clerk     (OAuth Google + GitHub + email/password)
Supabase DB    →  Neon      (base de datos nueva, sin importación)
supabase-js    →  pg + @clerk/backend
```

### Estado de ejecución

```
✅  Paso 4 — Proyecto Neon creado
✅  Paso 5 — Schema completo ejecutado en Neon
⚠️  Paso 6 — Migration 009 PENDIENTE (ejecutar en Neon SQL Editor)
✅  Paso 7 — Schema verificado
✅  Paso 8 — Clerk configurado (app, OAuth, webhook)
✅  Paso 9 — Backend completamente migrado
✅  Paso 10 — Frontend completamente migrado
→   Paso 11 — Variables de entorno en Railway/Vercel
→   Paso 12 — Validar en staging
→   Paso 13 — Cutover a producción
```

---

## 3. Exportar configuración de OAuth de Supabase

Antes de apagar Supabase, anota estos valores del dashboard — **no están en la DB**, son configuración del servicio:

**Supabase → Authentication → Providers → Google:**
- Client ID: `________________________________`
- Client Secret: `________________________________`

**Supabase → Authentication → Providers → GitHub:**
- Client ID: `________________________________`
- Client Secret: `________________________________`

> Los necesitarás para configurar los mismos providers en Clerk.

---

## 4. Crear proyecto en Neon

✅ Si ya lo creaste, salta al paso 6.

1. [console.neon.tech](https://console.neon.tech) → **New Project**
2. Nombre: `sendix-production`, región: `us-east-1` o `us-east-2`, PostgreSQL **16**
3. Guardar la connection string:

```
postgresql://[user]:[password]@[endpoint].neon.tech/neondb?sslmode=require
```

4. Crear rama `staging` en **Branches → New Branch** para pruebas.

---

## 5. SQL completo — schema en Neon

✅ **Ya ejecutado.** Se muestra como referencia. Ver también [Paso 6](#6-migración-009--fix-de-ids-para-clerk) para el fix de IDs de Clerk que debe ejecutarse encima de este schema.

<details>
<summary>Ver el SQL completo ejecutado</summary>

### Extensiones
```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
```

### profiles
```sql
CREATE TABLE IF NOT EXISTS profiles (
  id                     UUID PRIMARY KEY,
  email                  TEXT,
  plan                   TEXT NOT NULL DEFAULT 'free',
  emails_sent_this_month INTEGER NOT NULL DEFAULT 0,
  email_limit            INTEGER,
  billing_period_start   TIMESTAMPTZ DEFAULT NOW(),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer ON profiles(stripe_customer_id);
```

> ⚠️ El tipo de `id` fue UUID pero Clerk usa IDs TEXT (`user_xxxx`). El paso 6 lo corrige.

### api_keys
```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL,
  key_prefix      VARCHAR(16),
  last4           TEXT,
  scope           TEXT NOT NULL DEFAULT 'full_access',
  revoked         BOOLEAN NOT NULL DEFAULT FALSE,
  organization_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user   ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix) WHERE revoked = false;
```

### domains
```sql
CREATE TABLE IF NOT EXISTS domains (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  domain           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  dkim_tokens      TEXT[],
  ses_identity_arn TEXT,
  organization_id  UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);
CREATE INDEX IF NOT EXISTS idx_domains_user ON domains(user_id);
```

> ⚠️ La tabla `domains` original le faltan columnas. El paso 6 las agrega.

### messages
```sql
CREATE TABLE IF NOT EXISTS messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  api_key_id        UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  organization_id   UUID,
  to_email          TEXT NOT NULL,
  from_email        TEXT NOT NULL,
  subject           TEXT NOT NULL,
  html              TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  ses_message_id    TEXT,
  soft_bounce_count INTEGER DEFAULT 0,
  last_bounce_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_user    ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_api_key ON messages(api_key_id);
CREATE INDEX IF NOT EXISTS idx_messages_ses_id  ON messages(ses_message_id) WHERE ses_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_status  ON messages(status, created_at DESC);
```

### logs
```sql
CREATE TABLE IF NOT EXISTS logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  provider   TEXT,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_logs_message ON logs(message_id, created_at DESC);
```

### bounce_events
```sql
CREATE TABLE IF NOT EXISTS bounce_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                   TEXT NOT NULL,
  event_type              TEXT NOT NULL,
  bounce_type             TEXT,
  bounce_subtype          TEXT,
  complaint_feedback_type TEXT,
  message_id              TEXT,
  sns_message_id          TEXT,
  raw_payload             JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bounce_events_email  ON bounce_events(email);
CREATE INDEX IF NOT EXISTS idx_bounce_events_type   ON bounce_events(event_type, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bounce_events_sns_id ON bounce_events(sns_message_id);
```

### suppression_list
```sql
CREATE TABLE IF NOT EXISTS suppression_list (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  user_id    UUID REFERENCES profiles(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_global_email ON suppression_list(email) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_user_email   ON suppression_list(email, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppression_email ON suppression_list(email);
CREATE INDEX IF NOT EXISTS idx_suppression_user  ON suppression_list(user_id);
```

### unsubscribe_tokens
```sql
CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
  campaign_id UUID,
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 year',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_unsubscribe_token ON unsubscribe_tokens(token);
CREATE INDEX IF NOT EXISTS idx_unsubscribe_email ON unsubscribe_tokens(email, user_id);
```

### webhooks
```sql
CREATE TABLE IF NOT EXISTS webhooks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  events     TEXT[] NOT NULL DEFAULT '{}',
  secret     TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);
```

### Función increment_email_counter
```sql
CREATE OR REPLACE FUNCTION increment_email_counter(p_user_id UUID, p_count INT DEFAULT 1)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE profiles
  SET emails_sent_this_month = COALESCE(emails_sent_this_month, 0) + p_count
  WHERE id = p_user_id;
$$;
```

> ⚠️ La firma de esta función cambia de UUID a TEXT en el paso 6.

### Trigger updated_at
```sql
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

</details>

---

## 6. Migración 009 — Fix de IDs para Clerk

⚠️ **PENDIENTE — Ejecutar en Neon SQL Editor antes del primer deploy**

El schema original usaba `UUID` para los IDs de usuario, pero Clerk genera IDs en formato `user_xxxx` (TEXT). Esta migración corrige el tipo en todas las tablas afectadas y agrega columnas faltantes en `domains`.

El archivo está en: `backend/migrations/009_clerk_id_schema.sql`

```sql
-- ─── 1. Romper FKs antes de cambiar tipos ──────────────────────────────────
ALTER TABLE api_keys          DROP CONSTRAINT IF EXISTS api_keys_user_id_fkey;
ALTER TABLE domains           DROP CONSTRAINT IF EXISTS domains_user_id_fkey;
ALTER TABLE messages          DROP CONSTRAINT IF EXISTS messages_user_id_fkey;
ALTER TABLE suppression_list  DROP CONSTRAINT IF EXISTS suppression_list_user_id_fkey;
ALTER TABLE unsubscribe_tokens DROP CONSTRAINT IF EXISTS unsubscribe_tokens_user_id_fkey;
ALTER TABLE webhooks          DROP CONSTRAINT IF EXISTS webhooks_user_id_fkey;

-- ─── 2. Cambiar profiles.id de UUID → TEXT ────────────────────────────────
ALTER TABLE profiles ALTER COLUMN id TYPE TEXT;

-- ─── 3. Cambiar user_id en todas las tablas relacionadas ─────────────────
ALTER TABLE api_keys           ALTER COLUMN user_id TYPE TEXT;
ALTER TABLE domains            ALTER COLUMN user_id TYPE TEXT;
ALTER TABLE messages           ALTER COLUMN user_id TYPE TEXT;
ALTER TABLE suppression_list   ALTER COLUMN user_id TYPE TEXT;
ALTER TABLE unsubscribe_tokens ALTER COLUMN user_id TYPE TEXT;
ALTER TABLE webhooks           ALTER COLUMN user_id TYPE TEXT;

-- ─── 4. Re-crear las FKs ──────────────────────────────────────────────────
ALTER TABLE api_keys           ADD CONSTRAINT api_keys_user_id_fkey           FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE domains            ADD CONSTRAINT domains_user_id_fkey            FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE messages           ADD CONSTRAINT messages_user_id_fkey           FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE suppression_list   ADD CONSTRAINT suppression_list_user_id_fkey   FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE unsubscribe_tokens ADD CONSTRAINT unsubscribe_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE webhooks           ADD CONSTRAINT webhooks_user_id_fkey           FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ─── 5. Columnas faltantes en domains ────────────────────────────────────
ALTER TABLE domains ADD COLUMN IF NOT EXISTS verified               BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS ses_verification_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE domains ADD COLUMN IF NOT EXISTS ses_dkim_tokens         TEXT[];
ALTER TABLE domains ADD COLUMN IF NOT EXISTS ses_verified_at         TIMESTAMPTZ;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS verification_attempts   INTEGER NOT NULL DEFAULT 0;

-- ─── 6. Fix de la función increment_email_counter (UUID → TEXT) ───────────
CREATE OR REPLACE FUNCTION increment_email_counter(p_user_id TEXT, p_count INT DEFAULT 1)
RETURNS void LANGUAGE sql AS $$
  UPDATE profiles
  SET emails_sent_this_month = COALESCE(emails_sent_this_month, 0) + p_count
  WHERE id = p_user_id;
$$;
```

---

## 7. Verificar que el schema está correcto

Ejecuta esto en el **SQL Editor de Neon** para confirmar que todo se creó bien antes de continuar:

### Verificar tablas

```sql
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

Resultado esperado (9 tablas):

```
api_keys
bounce_events
domains
logs
messages
profiles
suppression_list
unsubscribe_tokens
webhooks
```

### Verificar que profiles.id es TEXT (post migración 009)

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'profiles' AND column_name = 'id';
-- Debe decir: character varying (TEXT), NO uuid
```

### Verificar columnas de domains (post migración 009)

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'domains'
ORDER BY column_name;
-- Deben aparecer: verified, ses_verification_status, ses_dkim_tokens, ses_verified_at, verification_attempts
```

### Verificar funciones

```sql
SELECT proname, pg_get_function_arguments(oid) AS args
FROM pg_proc
WHERE proname IN ('increment_email_counter', 'update_updated_at');
```

Resultado esperado post migración 009:

```
increment_email_counter  | p_user_id text, p_count integer
update_updated_at        |
```

### Verificar índices clave

```sql
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
```

Deben aparecer entre otros:
- `idx_api_keys_prefix` (en `api_keys`) — crítico para el lookup O(1)
- `idx_messages_ses_id` (en `messages`) — para tracking de bounces de SES
- `idx_bounce_events_sns_id` (en `bounce_events`) — único, para deduplicación

---

## 8. Configurar Clerk — Auth + OAuth

✅ **Completado**

### 8.1 Aplicación en Clerk

Aplicación `SendIX` creada con métodos: **Email**, **Google**, **GitHub**
- **Publishable key:** `pk_live_...` → en `VITE_CLERK_PUBLISHABLE_KEY`
- **Secret key:** `sk_live_...` → en `CLERK_SECRET_KEY`

### 8.2 Google y GitHub OAuth

Configurados en Clerk → Configure → Social connections.  
URLs de callback de Clerk añadidas en Google Cloud Console y GitHub OAuth App.

### 8.3 Webhook de Clerk

**Clerk → Configure → Webhooks → Add endpoint**
- URL: `https://api.sendix.lat/api/webhooks/clerk`
- Evento suscrito: **`user.created`** (solo este)
- Signing Secret copiado → `CLERK_WEBHOOK_SECRET`

---

## 9. Cambios en el backend

✅ **Completado** — todos los archivos están en el repositorio

### 9.1 Dependencias instaladas

```bash
npm install pg @clerk/backend svix
npm install --save-dev @types/pg
```

### 9.2 Archivos nuevos creados

| Archivo | Descripción |
|---------|-------------|
| `src/lib/db.ts` | Pool de conexión a Neon con SSL y health check al arrancar |
| `src/middleware/authClerkUser.ts` | Reemplaza `authSupabaseUser`. Verifica JWT con Clerk, cachea sesiones 2 min en memoria |
| `src/routes/webhooks-clerk.route.ts` | Recibe `user.created` de Clerk, crea fila en `profiles` |
| `src/routes/dashboard.route.ts` | `GET /api/dashboard/messages` y `POST /api/dashboard/send-email` con Clerk JWT |
| `migrations/009_clerk_id_schema.sql` | Cambia UUID → TEXT en todas las FKs, agrega columnas a `domains` |

### 9.3 Nota importante sobre `@clerk/backend`

En `@clerk/backend` v1+, `createClerkClient().verifyToken()` **no existe**. La forma correcta es importar `verifyToken` directamente:

```typescript
// ✅ Correcto
import { verifyToken } from '@clerk/backend'
const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! })

// ❌ No existe en v1+
const clerk = createClerkClient({ secretKey: ... })
await clerk.verifyToken(token)  // TypeError
```

### 9.4 Raw body para el webhook de Clerk

`svix` necesita el body **sin parsear** (Buffer) para verificar la firma. En `server.ts`:

```typescript
// Parsear /api/webhooks/clerk como raw Buffer (para svix)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhooks/clerk')) {
    express.raw({ type: 'application/json' })(req, res, next)
  } else {
    express.json()(req, res, next)
  }
})
```

Y en el route:
```typescript
const body = (req.body as Buffer).toString()
event = wh.verify(body, { 'svix-id': ..., 'svix-timestamp': ..., 'svix-signature': ... })
```

### 9.5 Archivos migrados de supabaseAdmin → db.query

| Archivo | Estado |
|---------|--------|
| `middleware/authApiKey.ts` | ✅ Migrado — bcrypt full-table scan corregido (bug de seguridad) |
| `middleware/authSupabaseUser.ts` | ✅ Reemplazado por `authClerkUser.ts` |
| `middleware/checkPlanLimits.ts` | ✅ Migrado |
| `routes/apiKeys.route.ts` | ✅ Migrado |
| `routes/domain.route.ts` | ✅ Migrado |
| `routes/billing.route.ts` | ✅ Migrado |
| `routes/suppression.route.ts` | ✅ Migrado |
| `routes/bounces.route.ts` | ✅ Migrado |
| `routes/send.route.ts` | ✅ Migrado |
| `routes/v1/emails.route.ts` | ✅ Migrado |
| `routes/index.ts` | ✅ Actualizado (dashboard route añadido) |
| `lib/cron.ts` | ✅ Migrado |
| `services/apiKey.service.ts` | ✅ Migrado (raw_key eliminado de schema) |
| `services/domain-ses.service.ts` | ✅ Migrado |
| `server.ts` | ✅ Actualizado (Clerk webhook raw body, ruta registrada) |

---

## 10. Cambios en el frontend

✅ **Completado** — todos los archivos están en el repositorio

### 10.1 Dependencias instaladas

```bash
npm install @clerk/clerk-react
```

### 10.2 Archivos actualizados

| Archivo | Cambio |
|---------|--------|
| `src/main.tsx` | `ClerkProvider` envolviendo la app |
| `src/hooks/useAuth.tsx` | Reescrito completo con Clerk hooks. Expone `getToken()` para llamadas al backend |
| `src/hooks/useTheme.tsx` | Eliminadas llamadas a Supabase — usa solo `localStorage` |
| `src/app/auth/callback.tsx` | Reemplazado con `<AuthenticateWithRedirectCallback />` de Clerk |
| `src/app/dashboard/page.tsx` | `fetchData` usa `/api/dashboard/messages`, `/api/api-keys`, `/api/domains` |
| `src/app/dashboard/domains/page.tsx` | `getAuthHeader()` usa `getToken()` de Clerk |
| `src/app/dashboard/api-keys/page.tsx` | `fetchApiKeys` usa `GET /api/api-keys?user_id=...` |
| `src/app/dashboard/suppression/page.tsx` | Usa `GET /api/suppression` + `DELETE /api/suppression/:email` con Bearer token |
| `src/app/dashboard/logs/page.tsx` | Usa `GET /api/dashboard/messages?days=N` con Bearer token |
| `src/app/dashboard/analytics/page.tsx` | Usa `GET /api/dashboard/messages?days=N` con Bearer token |
| `src/app/dashboard/send/page.tsx` | Usa `POST /api/dashboard/send-email` con Clerk JWT (eliminado `raw_key`) |
| `src/app/dashboard/settings/page.tsx` | Supabase Auth reemplazado; perfil en localStorage, uso desde dashboard/messages |
| `src/components/layout/Sidebar.tsx` | `user_metadata` → `user.fullName` |
| `src/components/layout/Topbar.tsx` | `user_metadata` → `user.fullName` |

### 10.3 Estado TypeScript

```
✅ 0 errores de TypeScript en frontend
✅ 0 errores de TypeScript en backend
```

### 10.4 Páginas no migradas (tablas inexistentes en Neon)

Las siguientes páginas usan tablas que no existen en el schema actual. Están **inactivas** y no afectan el core del producto:

- `campaigns/page.tsx`, `campaigns/new/page.tsx` — tabla `campaigns`
- `contacts/page.tsx` — tabla `contacts`
- `jobs/page.tsx` — tabla `jobs`
- `webhooks/page.tsx` — usaba `raw_key` de API keys (eliminado)
- `forgot-password.tsx`, `reset-password.tsx` — flujo Supabase (Clerk lo maneja nativo)

---

## 11. Variables de entorno

### Backend — Railway

```bash
# ── Neon ─────────────────────────────────────────────────────────
DATABASE_URL=postgresql://[user]:[pass]@[endpoint].neon.tech/neondb?sslmode=require

# ── Clerk ─────────────────────────────────────────────────────────
CLERK_SECRET_KEY=sk_live_...
CLERK_WEBHOOK_SECRET=whsec_...

# ── AWS SES ───────────────────────────────────────────────────────
AWS_SES_SMTP_HOST=email-smtp.us-east-2.amazonaws.com
AWS_SES_SMTP_PORT=587
AWS_SES_SMTP_USER=...
AWS_SES_SMTP_PASS=...
AWS_SES_FROM_DOMAIN=supportsendix.online
AWS_SES_FROM_EMAIL=onboarding@supportsendix.online
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-2

# ── Stripe ────────────────────────────────────────────────────────
STRIPE_SECRET_KEY=...
STRIPE_PRICE_PRO=...
STRIPE_PRICE_AGENCY=...
STRIPE_WEBHOOK_SECRET=...

# ── General ───────────────────────────────────────────────────────
PORT=3001
NODE_ENV=production
FRONTEND_URL=https://www.sendix.lat
CORS_ORIGINS=https://www.sendix.lat,http://localhost:3000
EMAIL_PROVIDER=ses
SNS_TOPIC_ARN=...
PUBLIC_API_URL=https://api.sendix.lat
RESEND_API_KEY=...

# ── ELIMINAR estas (ya no se usan) ───────────────────────────────
# SUPABASE_URL=...
# SUPABASE_SERVICE_ROLE_KEY=...
```

### Frontend — Vercel / .env

```bash
# ── Clerk ─────────────────────────────────────────────────────────
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...

# ── API ───────────────────────────────────────────────────────────
VITE_API_URL=https://api.sendix.lat

# ── ELIMINAR estas (ya no se usan) ───────────────────────────────
# VITE_SUPABASE_URL=...
# VITE_SUPABASE_ANON_KEY=...
```

---

## 12. Validación en staging

```bash
# 1. Verificar conexión a Neon
curl https://staging-api.sendix.lat/api/health

# 2. Registrar un usuario nuevo con Google en el frontend de staging
#    → Verificar en Neon que se creó la fila en profiles:
SELECT * FROM profiles ORDER BY created_at DESC LIMIT 1;
#    El id debe ser 'user_xxxx' (TEXT), no un UUID

# 3. Enviar email con una API key
curl -X POST https://staging-api.sendix.lat/api/v1/emails \
  -H "Authorization: Bearer sk_live_[key]" \
  -H "Content-Type: application/json" \
  -d '{"to":"test@test.com","subject":"Test Neon","html":"<p>OK desde Neon</p>"}'

# 4. Verificar en Neon que el contador se actualizó
SELECT emails_sent_this_month FROM profiles WHERE id = '[user_id]';

# 5. Crear un API key desde el dashboard
SELECT key_prefix, last4 FROM api_keys ORDER BY created_at DESC LIMIT 1;
-- key_prefix debe estar poblado; la columna raw_key NO debe existir

# 6. Verificar el dashboard: logs, analytics, dominios, API keys — deben cargar

# 7. Enviar email desde el panel de Send del dashboard (usa Clerk JWT, no API key)
```

---

## 13. Cutover a producción

```bash
# 1. Ejecutar migration 009 en Neon producción (SQL Editor)
#    → backend/migrations/009_clerk_id_schema.sql

# 2. En Railway — actualizar variables del backend:
#    DATABASE_URL          = postgresql://...neon.tech/neondb?sslmode=require
#    CLERK_SECRET_KEY      = sk_live_...
#    CLERK_WEBHOOK_SECRET  = whsec_...
#    (eliminar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY)

# 3. En Vercel — actualizar variables del frontend:
#    VITE_CLERK_PUBLISHABLE_KEY = pk_live_...
#    (eliminar VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY)

# 4. Redeploy del backend en Railway

# 5. Redeploy del frontend

# 6. Health check
curl https://api.sendix.lat/api/health

# 7. Login con Google en producción — verificar que funciona
#    Confirmar en Neon: SELECT id, email FROM profiles ORDER BY created_at DESC LIMIT 1;

# 8. Enviar un email de prueba real

# 9. En Google Cloud Console: eliminar la URL de Supabase de los redirect URIs autorizados
#    (solo después de confirmar que Clerk funciona)

# 10. Monitorear Railway logs + Neon dashboard durante 30 minutos
```

---

## 14. Checklist completo

### Neon — Base de datos

- [x] Proyecto creado en la región correcta
- [x] Rama `staging` creada
- [x] SQL del paso 5 ejecutado (9 tablas + 2 funciones + 1 trigger)
- [x] Schema verificado: 9 tablas presentes
- [x] `increment_email_counter` y `update_updated_at` presentes
- [x] `idx_api_keys_prefix` presente
- [x] Trigger `profiles_updated_at` presente
- [ ] **Migration 009 ejecutada** (`profiles.id` UUID → TEXT, columnas de `domains` añadidas) ⚠️

### Clerk — Autenticación

- [x] Aplicación Clerk creada (`SendIX`)
- [x] Publishable key y Secret key obtenidos
- [x] Google OAuth configurado en Clerk
- [x] GitHub OAuth configurado en Clerk
- [x] URL de callback de Clerk añadida en Google Cloud Console
- [x] URL de callback de Clerk añadida en GitHub OAuth App
- [x] Webhook `user.created` configurado → `POST /api/webhooks/clerk`
- [x] `CLERK_WEBHOOK_SECRET` copiado

### Backend

- [x] `pg`, `@clerk/backend`, `svix` instalados
- [x] `src/lib/db.ts` creado con Pool de Neon
- [x] `src/middleware/authClerkUser.ts` creado (usa `verifyToken` directo, caché de 2 min)
- [x] `src/routes/webhooks-clerk.route.ts` creado (raw body + svix)
- [x] `src/routes/dashboard.route.ts` creado (`GET /messages`, `POST /send-email`)
- [x] Webhook de Clerk registrado en `server.ts` con raw body parsing
- [x] Todos los `supabaseAdmin.from(...)` reemplazados por `db.query(...)`
- [x] `authSupabaseUser` reemplazado por `authClerkUser` en todas las rutas
- [x] Bug de seguridad corregido: bcrypt full-table scan en `authApiKey.ts`
- [x] 0 errores TypeScript en el backend
- [ ] Variables `DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` en Railway
- [ ] Variables `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` eliminadas de Railway

### Frontend

- [x] `@clerk/clerk-react` instalado
- [x] `ClerkProvider` envolviendo la app en `main.tsx`
- [x] `useAuth.tsx` reescrito con Clerk (`useUser`, `useAuth`, `useSignIn`, `useSignUp`)
- [x] `getToken()` expuesto en el contexto de auth para llamadas al backend
- [x] `useTheme.tsx` migrado a localStorage (sin Supabase)
- [x] `callback.tsx` → `<AuthenticateWithRedirectCallback />`
- [x] `domains/page.tsx` → Bearer token con `getToken()`
- [x] `dashboard/page.tsx` → API REST con Bearer token
- [x] `api-keys/page.tsx` → `GET /api/api-keys?user_id=...`
- [x] `suppression/page.tsx` → `GET/DELETE /api/suppression` con Bearer token
- [x] `logs/page.tsx` → `GET /api/dashboard/messages` con Bearer token
- [x] `analytics/page.tsx` → `GET /api/dashboard/messages` con Bearer token
- [x] `send/page.tsx` → `POST /api/dashboard/send-email` con Clerk JWT (sin `raw_key`)
- [x] `settings/page.tsx` → supabase.auth eliminado
- [x] `Sidebar.tsx` y `Topbar.tsx` → `user_metadata` → `user.fullName`
- [x] 0 errores TypeScript en el frontend
- [ ] `VITE_CLERK_PUBLISHABLE_KEY` en Vercel
- [ ] `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` eliminadas de Vercel

### Validación y cutover

- [ ] Migration 009 ejecutada en Neon SQL Editor
- [ ] Health check pasa en staging
- [ ] Registro con Google funciona en staging (profile creado en Neon con `id = user_xxxx`)
- [ ] Registro con GitHub funciona en staging
- [ ] Envío de email desde dashboard funciona
- [ ] Envío de email vía API key funciona
- [ ] Dashboard carga datos desde Neon correctamente (logs, analytics, dominios, API keys)
- [ ] Variables de Railway actualizadas para producción
- [ ] Deploy de backend y frontend en producción exitoso
- [ ] Login con Google funciona en producción
- [ ] URL de Supabase eliminada de Google Cloud Console (post-verificación)
- [ ] Monitoreo activo durante las primeras 24h

---

## Recursos

- [Neon docs](https://neon.tech/docs)
- [Neon SQL Editor](https://neon.tech/docs/get-started-with-neon/query-with-neon-sql-editor)
- [Neon branching](https://neon.tech/docs/introduction/branching)
- [Clerk docs](https://clerk.com/docs)
- [Clerk + Google OAuth](https://clerk.com/docs/authentication/social-connections/google)
- [Clerk + GitHub OAuth](https://clerk.com/docs/authentication/social-connections/github)
- [Clerk webhooks (svix)](https://clerk.com/docs/integrations/webhooks/overview)
- [`verifyToken` en @clerk/backend](https://clerk.com/docs/references/backend/sessions/verify-token)
