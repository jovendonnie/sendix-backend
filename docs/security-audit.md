# Auditoría de Seguridad — SendIX Backend

**Fecha:** 2026-06-02  
**Scope:** `sendix-backend/backend/src/`  
**Estado:** Vulnerabilidades críticas resueltas en este commit

---

## Incidente desencadenante

El dashboard de Supabase mostró ~500,000 peticiones en la última hora, con cientos de `PATCH /rest/v1/profiles` fallando con **error 522** (Cloudflare timeout) al mismo segundo (`07:22:04`). Esto colapsó el pool de conexiones de la base de datos.

---

## Vulnerabilidades encontradas y estado

### [CRÍTICA-1] `api_keys.raw_key` — Claves API almacenadas en texto plano

**Archivo:** `backend/src/services/apiKey.service.ts:58`  
**Estado:** ✅ Resuelto

**Descripción:**  
Al crear una API key, se almacenaba la clave completa en texto plano en la columna `raw_key`. Si la base de datos es comprometida, todos los API keys quedan expuestos al 100%.

```typescript
// ANTES (vulnerable)
.insert({ ..., key_hash: hashed, raw_key: rawKey, ... })

// DESPUÉS (seguro)
.insert({ ..., key_hash: hashed, key_prefix, ... })
```

**Acciones tomadas:**
- Eliminado `raw_key` del INSERT al crear claves
- `getUserApiKeys` ya no selecciona ni retorna `raw_key`
- Creada migración `008_remove_raw_key.sql` para eliminar la columna de la DB
- Se almacena solo `key_prefix` (primeros 16 chars, no secreto) para lookup O(1)

**Pasos pendientes del operador:**
1. Aplicar `migrations/006_api_key_prefix.sql` (backfill prefix desde raw_key)
2. Aplicar `migrations/008_remove_raw_key.sql` (eliminar columna raw_key)

---

### [CRÍTICA-2] `authApiKey` — Full table scan + N bcrypt por request

**Archivo:** `backend/src/middleware/authApiKey.ts`  
**Estado:** ✅ Resuelto

**Descripción:**  
Cada request autenticada con API key ejecutaba:
1. `SELECT * FROM api_keys WHERE revoked = false` → trae TODAS las claves de todos los usuarios
2. `bcrypt.compare(rawKey, key.key_hash)` para CADA fila devuelta

Con 50 claves activas y 1000 requests/minuto:
- **50,000 operaciones bcrypt/minuto** (bcrypt ~100-300ms/op)
- **1,000 queries completos a api_keys/minuto**

Esto por sí solo puede colapsar la base de datos bajo carga moderada.

**Solución aplicada:**
- Lookup por `key_prefix` (columna indexada) → 1 query, 1 fila, 1 bcrypt
- Caché en memoria con TTL 5 minutos → 0 queries en requests repetidos
- Fallback automático a full scan para keys legacy (hasta que se aplique la migración)

**Antes:** O(N) queries + O(N) bcrypt por request  
**Después:** O(1) query + O(1) bcrypt (primera vez), O(0) queries (caché)

---

### [CRÍTICA-3] `incrementEmailCounter` — SELECT + UPDATE generando 522 en cascada

**Archivo:** `backend/src/middleware/checkPlanLimits.ts`  
**Estado:** ✅ Resuelto — causa del incidente de 07:22:04

**Descripción:**  
Esta es la causa directa de los 522 observados en el dashboard. Por cada email enviado exitosamente:

```typescript
// 2 queries por email enviado (no atómico):
SELECT emails_sent_this_month FROM profiles WHERE id = ?  // Query 1
UPDATE profiles SET emails_sent_this_month = current + 1 WHERE id = ?  // Query 2
```

Si se envían 100 emails en paralelo (batch send), se generan **200 PATCH /rest/v1/profiles simultáneos**. Supabase tiene un límite de conexiones en el pool (por defecto 60 en el plan free). 200 conexiones simultáneas → timeout en cascada → 522.

**Solución aplicada:**
- Creada función SQL `increment_email_counter(p_user_id, p_count)` via migración 007
- Un solo `UPDATE` atómico: `SET emails_sent_this_month = COALESCE(emails_sent_this_month, 0) + p_count`
- Fallback automático al método legacy si el RPC no está desplegado

**Antes:** 2 queries por email enviado, no atómico  
**Después:** 1 query atómico via RPC

**Pasos pendientes del operador:**
1. Aplicar `migrations/007_increment_email_counter_fn.sql` en Supabase SQL Editor

---

### [ALTA-1] `authSupabaseUser` — 2 queries sin caché por cada request del dashboard

**Archivo:** `backend/src/middleware/authSupabaseUser.ts`  
**Estado:** ✅ Resuelto

**Descripción:**  
Cada request del panel de control (dominios, supresiones, bounces) ejecutaba:
1. `supabaseAdmin.auth.getUser(token)` — llama a la API de Supabase Auth
2. `SELECT plan FROM profiles WHERE id = ?` — query adicional

Los JWTs de Supabase son válidos por 1 hora. Revalidar contra la DB en cada request es innecesario.

**Solución aplicada:**
- Caché en memoria con TTL de 2 minutos por token
- Después del primer request: 0 queries por 2 minutos
- Se expone `invalidateSessionCache(token)` para logout/revocación explícita

---

### [ALTA-2] Logs de debug exponiendo datos sensibles en producción

**Archivos:**
- `apiKey.service.ts` — logueaba `rawKey`, `hashed`, y conteos de claves
- `authApiKey.ts` (versión anterior) — logueaba el header completo de Authorization, el rawKey, y el hash de cada clave

**Estado:** ✅ Resuelto  
Eliminados todos los `console.log` que exponían: tokens, hashes, user IDs en texto claro en logs de producción.

---

### [ALTA-3] Sin rate limiting en ningún endpoint (antes del fix)

**Estado:** ✅ Resuelto (en commit anterior)

Se instaló `express-rate-limit` con:
- `/api/auth/*`: 10 requests/IP/15min (login, register, reset password)
- `/api`, `/api/v1`: 200 requests/IP/15min

---

### [MEDIA-1] `x-user-id` header — sin validación de autenticidad

**Archivo:** `backend/src/routes/apiKeys.route.ts`  
**Estado:** ⚠️ Pendiente de evaluación

**Descripción:**  
Los endpoints `POST /api/api-keys` y `DELETE /api/api-keys/:id` reciben el `x-user-id` directamente del header sin verificar que el token JWT corresponde a ese user ID.

```typescript
const user_id = req.headers['x-user-id'] as string
// No hay verificación de que este user_id sea el del JWT autenticado
```

Cualquier cliente puede enviar un `x-user-id` arbitrario si tiene acceso al endpoint.

**Recomendación:**  
Los endpoints de gestión de API keys deberían usar `authSupabaseUser` para verificar el JWT y obtener el `userId` del token, no del header.

---

### [MEDIA-2] `checkApiKeyLimit` duplica lógica de `apiKey.service.countActiveKeys`

**Archivo:** `backend/src/middleware/checkPlanLimits.ts`  
**Estado:** ⚠️ Deuda técnica

Dos lugares distintos cuentan las API keys activas de un usuario, generando queries redundantes al crear una clave. Consolidar en un solo punto.

---

### [MEDIA-3] Stripe Webhook — sin validación de Content-Type strict

**Archivo:** `backend/src/routes/billing.route.ts`  
**Estado:** ✅ Mitigado (Stripe SDK valida la firma)  
La firma HMAC de Stripe es validada correctamente via `stripe.webhooks.constructEvent()`. Sin embargo, si el body parser falla antes del handler, la firma no se verifica. El routing condicional en `server.ts` maneja esto correctamente.

---

### [BAJA-1] CORS — origins configurables pero sin validación estricta

**Archivo:** `backend/src/server.ts`  
**Estado:** ⚠️ Revisar en producción

```typescript
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,...').split(',')
```

Si `CORS_ORIGINS` no está definida en producción, el fallback incluye `localhost`. Verificar que la variable esté siempre definida en Railway/producción.

---

### [BAJA-2] SNS webhook — no valida la firma de AWS SNS

**Archivo:** `backend/src/routes/webhooks-ses.route.ts`  
**Estado:** ⚠️ Pendiente

AWS SNS incluye una firma en cada mensaje. Sin validarla, cualquier actor puede hacer POST a `/api/webhooks/ses` con payloads falsos y marcar emails como bounced/spam.

**Recomendación:**  
Verificar `x-amz-sns-message-type` y validar la firma usando el certificado público de SNS que viene en el campo `SigningCertURL`.

---

## Resumen de acciones requeridas del operador

### Inmediato (antes del próximo deploy)

```bash
# En Supabase SQL Editor, en orden:
# 1. Backfill de prefijos (lee raw_key antes de borrarlo)
\i backend/migrations/006_api_key_prefix.sql

# 2. Función de incremento atómico
\i backend/migrations/007_increment_email_counter_fn.sql

# 3. Eliminar columna raw_key (plaintext)
\i backend/migrations/008_remove_raw_key.sql
```

### Después del deploy

- [ ] Verificar que los logs ya no muestran tokens ni hashes
- [ ] Confirmar que `PATCH /rest/v1/profiles` en el dashboard de Supabase vuelve a niveles normales
- [ ] Confirmar que el rate limiter devuelve 429 después de 200 requests/15min

### Prioridad media

- [ ] Refactorizar `POST /api/api-keys` para usar `authSupabaseUser` en vez de `x-user-id` header
- [ ] Agregar validación de firma SNS en `/api/webhooks/ses`
- [ ] Activar alertas en Supabase para queries/min > 500

---

## Métricas objetivo post-fix

| Métrica | Antes | Objetivo |
|---------|-------|----------|
| Queries por request autenticado (API key) | 1 + N×bcrypt | 0 (caché hit) / 1 + 1×bcrypt (miss) |
| Queries por request de dashboard | 2 | 0 (caché) / 2 (miss cada 2 min) |
| Queries por email enviado (contador) | 2 | 1 (RPC atómico) |
| PATCH /rest/v1/profiles bajo carga | N (uno por email en paralelo) | 1 (batched, atómico) |
| API keys en texto plano en DB | ✗ Sí | ✓ No |
