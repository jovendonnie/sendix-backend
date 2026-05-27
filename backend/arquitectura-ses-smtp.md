# Arquitectura AWS SES + SMTP Multi-Tenant — SendIX
> Documento de análisis e implementación. Última actualización: 2026-05-25

---

## Índice

1. [Análisis de la arquitectura propuesta](#1-análisis-de-la-arquitectura-propuesta)
2. [Qué existe hoy en SendIX](#2-qué-existe-hoy-en-sendix)
3. [Qué hay que construir](#3-qué-hay-que-construir)
4. [Parte 1 — Base de datos y migraciones](#parte-1--base-de-datos-y-migraciones)
5. [Parte 2 — Middleware de límites de plan](#parte-2--middleware-de-límites-de-plan)
6. [Parte 3 — Migración de smtp.ts a factoría dinámica](#parte-3--migración-de-smtpts-a-factoría-dinámica)
7. [Parte 4 — smtp-email.service.ts con enrutador de identidad](#parte-4--smtp-emailservicets-con-enrutador-de-identidad)
8. [Parte 5 — Módulo de automatización DNS con AWS SES API](#parte-5--módulo-de-automatización-dns-con-aws-ses-api)
9. [Parte 6 — Cron job de reseteo mensual de contadores](#parte-6--cron-job-de-reseteo-mensual-de-contadores)
10. [Parte 7 — Frontend: módulo de dominios Pro](#parte-7--frontend-módulo-de-dominios-pro)
11. [Variables de entorno completas](#variables-de-entorno-completas)
12. [Orden de implementación y dependencias](#orden-de-implementación-y-dependencias)
13. [Riesgos y decisiones críticas](#riesgos-y-decisiones-críticas)

---

## 1. Análisis de la arquitectura propuesta

### Separación de responsabilidades — correcto

La propuesta divide AWS SES en dos usos completamente distintos, lo cual es la decisión correcta:

| Uso | Herramienta | Para qué |
|-----|------------|----------|
| Envío de correos | SMTP de SES vía Nodemailer | Todos los planes. Mismas credenciales maestras de AWS, DKIM dinámico por cliente Pro |
| Gestión de dominios | SDK `@aws-sdk/client-ses` | Automatizar el registro y verificación de dominios de usuarios Pro/Agency |

Intentar hacer todo con un solo mecanismo sería el error. Esta separación permite que el plano de envío sea simple y estable, mientras el plano de administración maneja la complejidad de la verificación DNS.

### Modelo de identidad del remitente — correcto y necesario

El punto crítico que la propuesta resuelve bien es el problema del `From:` en SES:

- **Plan Free:** Envía desde `notificaciones@mail-sendix.com` (dominio propio de SendIX, pre-verificado en SES). El Reply-To lleva el email real del cliente. El destinatario responde al cliente, no a SendIX. Funciona de inmediato, sin que el usuario toque DNS.
- **Plan Pro/Agency:** Envía desde el propio dominio del cliente. SES exige que ese dominio esté verificado en la cuenta de AWS. La verificación se automatiza mediante el SDK de SES. El DKIM se firma dinámicamente en Nodemailer usando la clave privada del cliente guardada en Supabase.

### Caché de transporters — importante

La propuesta incluye un `Map` en memoria para no recrear el transporter de Nodemailer en cada email. Esto es correcto: crear un transporter tiene overhead de conexión TCP. El caché evita ese costo en cuentas con muchos envíos. **Punto a vigilar:** el caché vive en memoria del proceso de Express. Si Railway reinicia el proceso, el caché se vacía y se recrea en el siguiente envío — eso no es un problema, es el comportamiento esperado.

### Easy DKIM vs DKIM manual — decisión de diseño

La propuesta usa **Easy DKIM** de AWS (donde AWS gestiona el par de claves internamente y expone solo tokens CNAME). Esto simplifica radicalmente la implementación: no necesitas generar ni almacenar claves privadas en tu base de datos. SES firma el email automáticamente cuando el dominio está verificado.

**Implicación:** El código en `smtp.ts` que inyecta `dkim.privateKey` en el transporter **no aplica cuando usas Easy DKIM**. Con Easy DKIM, SES firma internamente al recibir el correo vía SMTP. El transporter de Nodemailer no necesita la clave — solo necesita que el `From:` use un dominio verificado con Easy DKIM activo en SES.

Esto simplifica la implementación: no hay tabla `dkim_private_key`, no hay inyección dinámica de clave en el transporter. Solo necesitas verificar el dominio del usuario en SES, y SES hace el resto.

### Contador de consumo mensual — ya existe parcialmente

SendIX ya tiene `checkPlanLimits` middleware que verifica el límite mensual. Lo que falta es:
- El campo `emails_sent_this_month` en `profiles` (o en una tabla separada de uso)
- El incremento del contador después de cada envío exitoso
- El cron de reseteo a 0 el día 1 de cada mes

---

## 2. Qué existe hoy en SendIX

```
backend/src/
├── middleware/
│   ├── authApiKey.ts          ✅ Valida API Key contra hash bcrypt
│   └── checkPlanLimits.ts     ✅ Verifica límite mensual (base existe, falta contador real)
├── routes/
│   ├── send.route.ts          ✅ POST /api/send y POST /api/send/bulk
│   ├── apiKeys.route.ts       ✅ CRUD de API Keys
│   └── billing.route.ts       ✅ Stripe checkout, portal, webhook
├── services/
│   ├── email.service.ts       ✅ Wrapper de Resend SDK (a reemplazar)
│   ├── message.service.ts     ✅ Persiste logs en tabla `messages`
│   ├── apiKey.service.ts      ✅ Creación con bcrypt, límite de 3 keys
│   └── domain.service.ts      ✅ Validación y almacenamiento de dominios
└── lib/
    └── supabaseAdmin.ts       ✅ Cliente Supabase con service role

Tablas Supabase actuales:
- profiles          ✅ (falta: emails_sent_this_month, email_limit)
- api_keys          ✅
- messages          ✅
- domains           ✅ (falta: dkim_selector, status de verificación SES)
- jobs              ✅
- webhooks          ✅
```

---

## 3. Qué hay que construir

| Parte | Qué | Archivos afectados |
|-------|-----|--------------------|
| 1 | Migraciones SQL de base de datos | Supabase SQL editor |
| 2 | Middleware de límites reforzado | `checkPlanLimits.ts` |
| 3 | smtp.ts como factoría dinámica | `lib/smtp.ts` (nuevo) |
| 4 | smtp-email.service con dispatcher | `services/smtp-email.service.ts` (nuevo) |
| 5 | Módulo DNS con AWS SES API | `services/domain-ses.service.ts` + `routes/domains.route.ts` |
| 6 | Cron de reseteo mensual | `lib/cron.ts` (nuevo) o Supabase scheduled function |
| 7 | Frontend: UI de dominios Pro | `app/dashboard/domains/` |

---

## Parte 1 — Base de datos y migraciones

### Qué hay que hacer

Dos migraciones SQL que deben ejecutarse en orden en el SQL editor de Supabase.

### Por qué

El contador mensual no puede vivir en memoria del backend (Railway puede reiniciar). Debe persistir en Supabase. La tabla `domains` existente necesita los campos de estado de verificación SES para saber si un dominio ya está listo para envíos Pro.

### Migración 1 — Contador de consumo en profiles

```sql
-- Agregar contador de consumo mensual al perfil del usuario
ALTER TABLE profiles 
  ADD COLUMN IF NOT EXISTS emails_sent_this_month INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_limit INTEGER NOT NULL DEFAULT 3000,
  ADD COLUMN IF NOT EXISTS billing_period_start TIMESTAMPTZ DEFAULT NOW();

-- Índice para el cron de reseteo (buscar todos los perfiles a resetear)
CREATE INDEX IF NOT EXISTS idx_profiles_billing_period 
  ON profiles(billing_period_start);

-- RLS: el backend con service_role puede actualizar el contador
-- (la política existente de service_role ya lo cubre)
```

### Migración 2 — Estado de verificación SES en domains

```sql
-- Extender la tabla domains existente con campos de SES
ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS ses_verification_status VARCHAR(20) DEFAULT 'not_started',
  -- Valores: 'not_started' | 'pending' | 'verified' | 'failed'
  ADD COLUMN IF NOT EXISTS ses_dkim_tokens TEXT[], -- Los 3 tokens CNAME que devuelve AWS
  ADD COLUMN IF NOT EXISTS ses_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_attempts INTEGER DEFAULT 0;

-- Índice para el módulo de verificación
CREATE INDEX IF NOT EXISTS idx_domains_ses_status 
  ON domains(ses_verification_status, user_id);
```

### Checklist

- [ ] Abrir Supabase → SQL Editor
- [ ] Ejecutar Migración 1 y confirmar que `profiles` tiene los tres campos nuevos
- [ ] Ejecutar Migración 2 y confirmar que `domains` tiene los cuatro campos nuevos
- [ ] Verificar que RLS sigue activo en ambas tablas después de las migraciones
- [ ] Confirmar que los usuarios existentes tienen `email_limit` correcto según su plan (actualizar manualmente si es necesario)

---

## Parte 2 — Middleware de límites de plan

### Qué hay que hacer

Reforzar `checkPlanLimits.ts` para que lea el contador real de `profiles.emails_sent_this_month` y lo compare contra `profiles.email_limit`. Después de cada envío exitoso, incrementar el contador en 1 (o en N para envíos bulk).

### Por qué

El middleware actual existe pero no tiene un contador real persistido. Sin este paso, los límites del plan no se aplican de verdad.

### Lógica del middleware

```
checkPlanLimits:
1. Obtener user_id desde la API Key validada por authApiKey
2. SELECT emails_sent_this_month, email_limit FROM profiles WHERE id = user_id
3. Si emails_sent_this_month >= email_limit → responder 402 con mensaje claro
4. Si OK → next() y pasar control a la ruta
```

### Lógica del incremento (en message.service.ts)

```
Después de registrar el envío en la tabla messages:
UPDATE profiles 
SET emails_sent_this_month = emails_sent_this_month + 1
WHERE id = user_id
```

Para bulk: incrementar en `batch.length` en lugar de 1.

### Checklist

- [ ] Leer el código actual de `checkPlanLimits.ts` para entender qué valida hoy
- [ ] Modificar para que haga `SELECT` de los dos campos nuevos de `profiles`
- [ ] Responder `402` con JSON `{ error: 'monthly_limit_reached', limit: N, sent: N }` si se supera
- [ ] Modificar `message.service.ts` para incrementar el contador después de cada envío exitoso
- [ ] Manejar el caso bulk: recibir el número de destinatarios y hacer `+= count` en lugar de `+= 1`
- [ ] Verificar que si el envío falla (Resend/SES devuelve error) el contador NO se incrementa

---

## Parte 3 — Migración de smtp.ts a factoría dinámica

### Qué hay que hacer

Crear `backend/src/lib/smtp.ts` como una función `getSmtpTransporter()` que retorna el transporter correcto según si el dominio del usuario usa Easy DKIM de SES o el dominio compartido de SendIX.

### Por qué

Con Easy DKIM de AWS no necesitas inyectar claves en Nodemailer. El transporter siempre se conecta a las mismas credenciales SMTP maestras de AWS. La diferencia entre Free y Pro es únicamente el `From:` del correo: si el `From:` usa un dominio verificado en SES con Easy DKIM activo, SES firmará automáticamente. Si usa el dominio compartido de SendIX, también funciona (ese dominio ya está verificado).

### Lógica de la factoría

```
getSmtpTransporter(domainKey?: string):
- domainKey = identificador de caché (dominio del cliente o 'free')
- Si ya existe en transporterCache → retornarlo
- Crear transporter con:
    host: AWS_SES_SMTP_HOST
    port: 465 (TLS) o 587 (STARTTLS)
    auth: { user: AWS_SES_SMTP_USER, pass: AWS_SES_SMTP_PASS }
    pool: true, maxConnections: 5
- Guardar en cache y retornar
```

**No hay diferencia de configuración entre Free y Pro en el transporter.** La diferencia solo está en el `From:` que se le pasa a `sendMail()`. Con Easy DKIM, SES detecta el dominio del `From:`, verifica que esté registrado con Easy DKIM, y firma automáticamente.

### Checklist

- [ ] Crear `backend/src/lib/smtp.ts`
- [ ] Implementar `getSmtpTransporter(domainKey?: string)` con caché en `Map`
- [ ] Configurar el transporter con `pool: true` y `maxConnections: 5`
- [ ] Soportar puerto 465 (SSL) y 587 (STARTTLS) según la variable de entorno `SMTP_PORT`
- [ ] Exportar también una función `clearTransporterCache(domainKey: string)` para cuando un dominio es revocado
- [ ] Agregar manejo de errores de conexión con log claro

---

## Parte 4 — smtp-email.service.ts con enrutador de identidad

### Qué hay que hacer

Crear `backend/src/services/smtp-email.service.ts` que centraliza la lógica del dispatcher: decide si el envío es Free (dominio de SendIX) o Pro (dominio verificado del cliente), construye los headers correctos y llama al transporter.

### Flujo completo del dispatcher

```
sendEmail(userId, payload):

1. SELECT * FROM domains 
   WHERE user_id = userId 
   AND ses_verification_status = 'verified'
   LIMIT 1

2. Si no hay dominio verificado (Free):
   - from = "NombreCliente <notificaciones@mail-sendix.com>"
   - replyTo = payload.from (el email real del cliente)
   - transporter = getSmtpTransporter('free')

3. Si hay dominio verificado (Pro/Agency):
   - Validar que payload.from termina en @dominio_verificado
   - Si no coincide → error 400 "El remitente no pertenece a tu dominio verificado"
   - from = payload.from (se usa tal cual)
   - transporter = getSmtpTransporter(dominio_verificado)

4. transporter.sendMail({ from, to, subject, html, text, replyTo })

5. Retornar { messageId, accepted, rejected }
```

### Checklist

- [ ] Crear `backend/src/services/smtp-email.service.ts`
- [ ] Implementar la query a `domains` para buscar dominio verificado del usuario
- [ ] Implementar lógica Free: sobreescribir `from`, agregar `replyTo`
- [ ] Implementar lógica Pro: validar que el `from` del payload pertenece al dominio verificado
- [ ] Llamar a `getSmtpTransporter()` con la clave correcta
- [ ] Retornar estructura compatible con la que retornaba `email.service.ts` de Resend (para no romper `message.service.ts`)
- [ ] Modificar `send.route.ts` para que use `smtp-email.service.ts` en lugar de `email.service.ts`
- [ ] Dejar `email.service.ts` con Resend intacto temporalmente como fallback hasta confirmar que SES funciona

---

## Parte 5 — Módulo de automatización DNS con AWS SES API

### Qué hay que hacer

Crear el servicio y las rutas que automatizan el flujo de verificación de dominios en AWS SES para usuarios Pro/Agency. Elimina la necesidad de que el administrador entre a la consola de AWS manualmente.

### Dependencia de instalación

Antes de implementar, preguntar si instalar `@aws-sdk/client-ses`. Es la única librería nueva necesaria para esta parte.

### Flujo completo de verificación de dominio

```
PASO 1 — Usuario registra su dominio (POST /api/domains)
  → Backend llama a SES: VerifyDomainDkimCommand({ Domain: "empresa.com" })
  → AWS devuelve 3 tokens CNAME
  → Backend guarda en domains: { ses_verification_status: 'pending', ses_dkim_tokens: [...] }
  → Frontend muestra los 3 CNAME al usuario para que los agregue en su proveedor DNS

PASO 2 — Usuario hace clic en "Verificar" (POST /api/domains/:id/verify)
  → Backend llama a SES: GetIdentityVerificationAttributesCommand({ Identities: ["empresa.com"] })
  → Si status === "Success":
      UPDATE domains SET ses_verification_status = 'verified', ses_verified_at = NOW()
  → Si status !== "Success":
      UPDATE domains SET verification_attempts = verification_attempts + 1
  → Retornar estado al frontend

PASO 3 — Usuario revoca su dominio (DELETE /api/domains/:id)
  → Backend llama a SES: DeleteIdentityCommand({ Identity: "empresa.com" })
  → UPDATE domains SET ses_verification_status = 'not_started', ses_dkim_tokens = NULL
  → clearTransporterCache("empresa.com")
```

### Registros DNS que hay que mostrar al usuario

Los tokens CNAME que AWS devuelve tienen el formato:

```
# Para cada token en ses_dkim_tokens:
NOMBRE:  {token}._domainkey.empresa.com
TIPO:    CNAME
VALOR:   {token}.dkim.amazonses.com

# SPF (agregar al TXT raíz del dominio)
NOMBRE:  empresa.com
TIPO:    TXT
VALOR:   "v=spf1 include:amazonses.com ~all"

# DMARC (recomendado)
NOMBRE:  _dmarc.empresa.com
TIPO:    TXT
VALOR:   "v=DMARC1; p=quarantine; rua=mailto:dmarc@empresa.com; pct=100"
```

### Nuevas variables de entorno necesarias

```
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
```

⚠️ El usuario IAM de AWS debe tener permisos de SES: `ses:VerifyDomainDkim`, `ses:GetIdentityVerificationAttributes`, `ses:DeleteIdentity`.

### Checklist

- [ ] Preguntar si instalar `@aws-sdk/client-ses` antes de proceder
- [ ] Crear `backend/src/lib/ses-client.ts` con el cliente SES configurado con las credenciales IAM
- [ ] Crear `backend/src/services/domain-ses.service.ts` con las tres funciones: `registerDomain`, `verifyDomainStatus`, `revokeDomain`
- [ ] Crear o modificar `backend/src/routes/domains.route.ts` con los endpoints POST, POST /:id/verify, DELETE /:id
- [ ] Proteger todas las rutas con `authApiKey` middleware
- [ ] Validar en `registerDomain` que el usuario tenga plan Pro o Agency antes de llamar a AWS (plan Free no puede registrar dominios propios)
- [ ] Crear política IAM en AWS con los permisos mínimos necesarios y documentar el ARN
- [ ] Agregar manejo de errores para cuando AWS rechaza el dominio (dominio inválido, ya registrado, etc.)
- [ ] Testear el flujo completo con un dominio real de prueba

---

## Parte 6 — Cron job de reseteo mensual de contadores

### Qué hay que hacer

Resetear `emails_sent_this_month = 0` en todos los usuarios el día 1 de cada mes (o en la fecha de renovación de su ciclo de billing).

### Dos opciones de implementación

**Opción A — Supabase Scheduled Functions (recomendada)**

Supabase permite ejecutar funciones SQL en horario usando `pg_cron`. No requiere que el backend de Railway esté corriendo.

```sql
-- En Supabase: Extensions → habilitar pg_cron
-- Luego en SQL Editor:
SELECT cron.schedule(
  'reset-monthly-email-counters',
  '0 0 1 * *',  -- A las 00:00 del día 1 de cada mes
  $$
    UPDATE profiles 
    SET emails_sent_this_month = 0,
        billing_period_start = NOW()
    WHERE emails_sent_this_month > 0;
  $$
);
```

**Opción B — Cron en el backend Express**

Si se prefiere tener todo el control en el backend, usar `node-cron` (preguntar antes de instalar):

```
cron.schedule('0 0 1 * *', async () => {
  await supabaseAdmin
    .from('profiles')
    .update({ emails_sent_this_month: 0, billing_period_start: new Date() })
    .gt('emails_sent_this_month', 0)
})
```

### Checklist

- [ ] Decidir entre Opción A (Supabase pg_cron) o Opción B (node-cron en Express)
- [ ] Si Opción A: habilitar extensión `pg_cron` en Supabase → Extensions
- [ ] Implementar el job elegido
- [ ] Verificar que el reseteo solo afecta perfiles con `emails_sent_this_month > 0` (optimización)
- [ ] Agregar log del reseteo (cuántos perfiles se resetearon, timestamp)
- [ ] Considerar si el reseteo debe ser por fecha de inicio del ciclo Stripe en lugar del día 1 del mes (más preciso para usuarios que se suscriben en distintas fechas)

---

## Parte 7 — Frontend: módulo de dominios Pro

### Qué hay que hacer

Actualizar la página `/dashboard/domains` para soportar el flujo completo de verificación de dominios Pro: agregar dominio, mostrar registros DNS, botón de verificar, estado visual del dominio.

### Estados visuales del dominio

```
not_started → El usuario aún no ha agregado su dominio
pending     → Dominio registrado en SES, esperando que el usuario agregue los CNAME en su DNS
verified    → Dominio listo para envíos Pro con DKIM
failed      → Más de 3 intentos de verificación fallidos, guiar al usuario a revisar su DNS
```

### Componentes nuevos necesarios

- `DomainRegistrationForm` — Input de dominio, validación básica de formato
- `DnsRecordsPanel` — Muestra los 3 CNAME + SPF + DMARC con botón de copiar para cada registro
- `DomainStatusBadge` — Chip de color según el estado (`pending` = amarillo, `verified` = verde, `failed` = rojo)
- `VerifyDomainButton` — Llama a `POST /api/domains/:id/verify` y actualiza el estado en tiempo real

### Flujo de UX

```
1. Usuario está en /dashboard/domains
2. Si plan Free → mostrar banner "Actualiza a Pro para usar tu dominio"
3. Si plan Pro/Agency → mostrar botón "Agregar dominio"
4. Al agregar: backend llama a SES → frontend muestra DnsRecordsPanel con los 3 CNAME
5. Usuario agrega los CNAME en Cloudflare/GoDaddy (puede tardar minutos u horas)
6. Usuario vuelve y hace clic en "Verificar dominio" → feedback inmediato del estado
7. Si verified: el dominio aparece disponible en el selector de From en /dashboard/send
```

### Checklist

- [ ] Leer el componente actual de `/dashboard/domains` para entender qué existe
- [ ] Agregar gate de plan: solo Pro/Agency puede agregar dominios propios
- [ ] Crear `DomainRegistrationForm` con validación de formato de dominio
- [ ] Crear `DnsRecordsPanel` que lea los tokens CNAME de la respuesta y los muestre formateados con copiar-al-portapapeles
- [ ] Crear `DomainStatusBadge` con los 4 estados visuales
- [ ] Crear `VerifyDomainButton` con estado de loading durante la llamada
- [ ] Actualizar `/dashboard/send`: el selector de From debe filtrar `ses_verification_status = 'verified'` (fix del bug conocido)
- [ ] Actualizar `lib/api.ts` con los helpers tipados para los nuevos endpoints de dominios

---

## Variables de entorno completas

### Backend `.env` — agregar a las existentes

```bash
# AWS SES SMTP (para envío de correos)
AWS_SES_SMTP_HOST=email-smtp.us-east-1.amazonaws.com
AWS_SES_SMTP_PORT=465
AWS_SES_SMTP_USER=AKIAXXXXXXXXXXXXXXXX
AWS_SES_SMTP_PASS=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
AWS_SES_FROM_DOMAIN=mail-sendix.com     # Dominio compartido para plan Free
AWS_SES_FROM_EMAIL=notificaciones@mail-sendix.com

# AWS SES API (para verificación de dominios)
AWS_ACCESS_KEY_ID=AKIAXXXXXXXXXXXXXXXX
AWS_SECRET_ACCESS_KEY=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
AWS_REGION=us-east-1

# Control del proveedor (para rollback fácil)
EMAIL_PROVIDER=ses   # 'ses' | 'resend'
```

---

## Orden de implementación y dependencias

```
Parte 1 (DB)
    │
    ├──► Parte 2 (Middleware límites) — necesita los campos de profiles
    │
    ├──► Parte 3 (smtp.ts factoría)
    │         │
    │         └──► Parte 4 (smtp-email.service dispatcher) — necesita smtp.ts + campos de domains
    │                   │
    │                   └──► Parte 5 (módulo DNS) — puede hacerse en paralelo con Parte 4
    │
    ├──► Parte 6 (Cron reseteo) — necesita solo Parte 1
    │
    └──► Parte 7 (Frontend) — necesita Parte 4 + Parte 5 completos
```

**Orden recomendado de sprints:**

| Sprint | Partes | Resultado |
|--------|--------|-----------|
| 1 | Parte 1 + Parte 6 | Contadores funcionando y reseteándose |
| 2 | Parte 2 | Límites de plan aplicados de verdad |
| 3 | Parte 3 + Parte 4 | Envío por SES SMTP funcionando end-to-end |
| 4 | Parte 5 | Verificación de dominios automatizada |
| 5 | Parte 7 | Frontend completo del módulo de dominios |

---

## Riesgos y decisiones críticas

### 1. Easy DKIM vs DKIM manual
Con Easy DKIM, AWS gestiona las claves. No necesitas guardar `dkim_private_key` en tu base de datos. **Decisión: usar Easy DKIM.** Es más simple, más seguro, y AWS rota las claves automáticamente.

### 2. Sandbox de AWS SES
AWS SES empieza en modo sandbox donde solo puedes enviar a emails verificados manualmente. **Acción obligatoria antes de ir a producción:** solicitar acceso a producción en la consola de SES → Account dashboard → Request production access. Sin esto, los emails de usuarios reales serán rechazados.

### 3. Dominio compartido para Free
El dominio `mail-sendix.com` (o el que elijas) debe estar verificado en SES con Easy DKIM **antes** de que el primer usuario Free envíe un correo. Hacerlo una sola vez manualmente en la consola de AWS es suficiente.

### 4. Reputación del dominio compartido
Si un usuario Free envía spam desde `notificaciones@mail-sendix.com`, afecta la reputación de ese dominio para todos los usuarios Free. Considerar implementar la suppression list de SES (webhooks de bounces y quejas) desde el inicio para proteger la reputación.

### 5. Rollback
La variable `EMAIL_PROVIDER=ses|resend` permite volver a Resend en segundos si hay algún problema con SES. No eliminar `email.service.ts` de Resend hasta que SES lleve al menos 2 semanas estable en producción.

### 6. Permisos IAM mínimos
El usuario IAM de AWS usado para el SDK de SES API debe tener **solo** los permisos necesarios:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "ses:VerifyDomainDkim",
      "ses:GetIdentityVerificationAttributes",
      "ses:DeleteIdentity",
      "ses:SendRawEmail"
    ],
    "Resource": "*"
  }]
}
```
Las credenciales SMTP de SES son distintas a las de IAM — generarlas desde SES → SMTP Settings, no desde IAM directamente.
