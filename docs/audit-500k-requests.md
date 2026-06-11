# Auditoría: 500,000 peticiones a la base de datos

**Fecha:** 2026-06-02  
**Gravedad:** Crítica  
**Estado:** En investigación / Mitigación aplicada

---

## Resumen ejecutivo

La base de datos de Supabase recibió aproximadamente 500,000 peticiones en un período anormal, causando degradación del servicio y posible agotamiento del pool de conexiones. Este documento identifica las causas raíz encontradas en el código del backend y propone acciones correctivas.

---

## Causas raíz identificadas

### 1. `authApiKey.ts` — Full table scan + bcrypt en cada request (CRÍTICO)

**Impacto estimado: 60–80% del total de peticiones**

```typescript
// Cada request autenticada con API key ejecuta esto:
const { data: keys } = await supabaseAdmin
  .from('api_keys')
  .select('id, user_id, name, key_hash, scope, organization_id')
  .eq('revoked', false)  // ← Sin filtro por key prefix. Trae TODAS las claves activas.

for (const key of keys) {
  const isMatch = await bcrypt.compare(rawKey, key.key_hash) // ← bcrypt es lento (~100-300ms/op)
}
```

**Por qué esto es catastrófico:**

- Se hace `SELECT * FROM api_keys WHERE revoked = false` sin ningún filtro por usuario ni prefijo, trayendo la tabla completa.
- Luego se corre `bcrypt.compare()` contra CADA clave existente. bcrypt está diseñado intencionalmente para ser lento (~100–300ms por operación).
- Con 50 API keys activas y 100 requests/minuto: **5,000 operaciones bcrypt/minuto**.
- Con 100 requests/minuto: **100 queries completos a la tabla api_keys por minuto**.
- Bajo carga real (retry loops, múltiples clientes), esto se multiplica exponencialmente.

**Solución correctiva:**

```typescript
// En vez de traer todas las claves, usar un prefijo único para lookup O(1):
// 1. Al crear la key, guardar el prefijo (primeros 8 chars) en una columna indexada.
// 2. Al autenticar:
const prefix = rawKey.substring(0, 8)
const { data: keys } = await supabaseAdmin
  .from('api_keys')
  .select('id, user_id, name, key_hash, scope')
  .eq('key_prefix', prefix)   // ← Busca solo 1 fila (con índice en key_prefix)
  .eq('revoked', false)
  .limit(1)
// Solo 1 bcrypt.compare() en vez de N
```

---

### 2. `authSupabaseUser.ts` — 2 queries a la DB por cada request autenticada

**Impacto estimado: 15–25% del total de peticiones**

```typescript
// Llamada 1: Valida el JWT contra la API de Supabase Auth
const { data: { user } } = await supabaseAdmin.auth.getUser(token)

// Llamada 2: Obtiene el plan del usuario
const { data: profile } = await supabaseAdmin
  .from('profiles')
  .select('plan')
  .eq('id', user.id)
  .single()
```

**Problema:** Sin caché de ningún tipo. Cada request que pase por `authSupabaseUser` genera 2 roundtrips a la base de datos. Los JWTs de Supabase son válidos por 1 hora — durante ese tiempo, el token podría validarse localmente o cachearse.

**Solución correctiva:**

```typescript
// Opción A: Cache en memoria con TTL corto (1–5 min)
const tokenCache = new Map<string, { userId: string; plan: string; expiresAt: number }>()

// Opción B: Validar el JWT localmente con la clave pública de Supabase (sin DB)
// usando jsonwebtoken + la JWKS de Supabase
```

---

### 3. `checkPlanLimits.ts` — 2 queries por cada email enviado (no atómico)

**Impacto estimado: 10–15% del total de peticiones**

```typescript
// checkEmailLimit: 1 query por envío (aceptable)
// PERO incrementEmailCounter hace 2 queries en vez de 1:

// Query 1: SELECT para obtener el contador actual
const { data: profile } = await supabaseAdmin
  .from('profiles')
  .select('emails_sent_this_month')
  .eq('id', userId)
  .single()

// Query 2: UPDATE con el valor nuevo
await supabaseAdmin
  .from('profiles')
  .update({ emails_sent_this_month: current + count })
  .eq('id', userId)
```

**Problema:** El patrón SELECT → UPDATE no es atómico y genera el doble de queries necesarios.

**Solución correctiva:**

```sql
-- Usar un RPC (función de Supabase) con UPDATE atómico:
UPDATE profiles
SET emails_sent_this_month = emails_sent_this_month + $count
WHERE id = $userId
```

```typescript
// En el cliente:
await supabaseAdmin.rpc('increment_email_counter', { user_id: userId, count })
```

---

### 4. Sin rate limiting (ANTES de este fix)

**Impacto: Amplificador de todos los problemas anteriores**

No existía ningún rate limiter en ningún endpoint. Esto significa que:

- Un cliente con un bug de retry infinito puede generar miles de requests por segundo.
- Un bot o scraper puede hacer fuerza bruta sin restricciones.
- Un frontend con un `useEffect` sin dependencias correctas puede hacer polling descontrolado.

**Fix aplicado:** Se instaló `express-rate-limit` con:
- `/api/auth/*`: 10 requests por IP cada 15 minutos (login, register, reset password)
- `/api` y `/api/v1`: 200 requests por IP cada 15 minutos

---

### 5. Frontend — Posibles fuentes de peticiones en bucle

**Impacto: Variable, potencialmente alto**

Patrones de frontend que pueden generar cientos de requests por minuto:

| Patrón | Descripción | Señal de alerta |
|--------|-------------|-----------------|
| `useEffect` sin array de dependencias | Se ejecuta en cada re-render | Logs con el mismo endpoint repetido en milisegundos |
| Polling sin control | `setInterval` haciendo fetch sin backoff | Requests con intervalos exactamente iguales |
| Retry automático agresivo | Librería de fetching (SWR, React Query) mal configurada | Requests que se aceleran tras un error 4xx/5xx |
| Auth refresh en bucle | El token expiró y el cliente intenta renovarlo infinitamente | Muchos requests a `/auth/token` o equivalente |
| Supabase `onAuthStateChange` sin cleanup | El listener se registra múltiples veces | Duplicación de requests de auth |

**Recomendación:** Revisar en el dashboard de Supabase qué endpoints específicos concentran el volumen de requests y cruzar con el código del frontend.

---

### 6. Supabase connection pool

**Impacto: Efecto secundario de los anteriores**

Supabase usa PgBouncer en modo de transacción por defecto. Con los problemas anteriores generando cientos de queries concurrentes:

- Se agotan las conexiones disponibles del pool.
- Las queries empiezan a encolar y finalmente timeout.
- Los timeouts causan retries en el cliente → más peticiones → más agotamiento (espiral).

---

## Resumen de impacto estimado

| Causa | % del total estimado | Severidad |
|-------|----------------------|-----------|
| `authApiKey` full scan + bcrypt loop | 60–80% | Crítica |
| `authSupabaseUser` sin caché (2 queries/req) | 15–25% | Alta |
| `incrementEmailCounter` no atómico | 10–15% | Media |
| Sin rate limiting (amplificador) | N/A | Crítica |
| Frontend polling/retry loops | Variable | Alta |
| Agotamiento del connection pool | Efecto secundario | Alta |

---

## Acciones aplicadas

- [x] Instalado `express-rate-limit` v7
- [x] Rate limiter de auth: 10 requests/IP/15min en `/api/auth/*`
- [x] Rate limiter general: 200 requests/IP/15min en `/api` y `/api/v1`

## Acciones pendientes (recomendadas)

- [ ] Refactorizar `authApiKey.ts`: agregar columna `key_prefix` indexada y hacer lookup O(1)
- [ ] Agregar caché en memoria para `authSupabaseUser` (TTL 2 min)
- [ ] Convertir `incrementEmailCounter` a un RPC atómico
- [ ] Revisar el frontend en busca de `useEffect` sin dependencias o polling descontrolado
- [ ] Activar `pg_bouncer` en modo sesión si el pool de transacciones se satura
- [ ] Agregar alertas en Supabase para queries/min > umbral

---

## Referencias

- [express-rate-limit docs](https://express-rate-limit.mintlify.app)
- [Supabase connection pooling](https://supabase.com/docs/guides/database/connection-pooling)
- [bcrypt timing attacks & API key design](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
