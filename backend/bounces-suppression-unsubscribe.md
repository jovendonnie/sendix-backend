# Bounces · Suppression List · Unsubscribe — SendIX
> Documento de análisis e implementación. Última actualización: 2026-05-27

---

## Índice

1. [Por qué esto es crítico antes que cualquier otra feature](#1-por-qué-esto-es-crítico-antes-que-cualquier-otra-feature)
2. [Qué existe hoy en SendIX](#2-qué-existe-hoy-en-sendix)
3. [Mapa completo del sistema](#3-mapa-completo-del-sistema)
4. [Parte 1 — Migraciones de base de datos](#parte-1--migraciones-de-base-de-datos)
5. [Parte 2 — Configuración de SNS en AWS](#parte-2--configuración-de-sns-en-aws)
6. [Parte 3 — Webhook receptor de notificaciones SNS](#parte-3--webhook-receptor-de-notificaciones-sns)
7. [Parte 4 — Suppression list: verificación antes de envío](#parte-4--suppression-list-verificación-antes-de-envío)
8. [Parte 5 — Mecanismo de unsubscribe](#parte-5--mecanismo-de-unsubscribe)
9. [Parte 6 — Dashboard: visibilidad de bounces y bajas](#parte-6--dashboard-visibilidad-de-bounces-y-bajas)
10. [Variables de entorno adicionales](#variables-de-entorno-adicionales)
11. [Orden de implementación y dependencias](#orden-de-implementación-y-dependencias)
12. [Umbrales de SES y alertas](#umbrales-de-ses-y-alertas)

---

## 1. Por qué esto es crítico antes que cualquier otra feature

AWS SES monitorea continuamente dos métricas de reputación de tu cuenta:

| Métrica | Umbral de advertencia | Umbral de suspensión |
|---------|-----------------------|----------------------|
| Bounce rate | > 2% | > 5% |
| Complaint rate | > 0.08% | > 0.1% |

Si cualquiera de esas métricas supera el umbral de suspensión, AWS congela el envío de toda la cuenta — todos tus usuarios dejan de poder enviar correos hasta que resuelvas el problema con soporte de AWS. El proceso de rehabilitación puede tardar días.

Un solo cliente que importe una lista de emails comprada o desactualizada puede arruinar la reputación de toda tu cuenta SES compartida.

**Sin este sistema implementado, no puedes abrir SendIX a usuarios reales.**

---

## 2. Qué existe hoy en SendIX

```
backend/src/
├── routes/
│   └── webhooks (tabla existe, rutas parciales)   ⚠️ No hay webhook para SES/SNS
├── services/
│   └── message.service.ts                         ✅ Registra status en tabla messages
│
Supabase:
├── messages    ✅ Existe, tiene campo status
├── webhooks    ✅ Tabla existe (para webhooks de usuarios, no de SES)
│
Falta todo:
├── suppression_list          ❌ No existe
├── unsubscribe_tokens        ❌ No existe
├── bounce_events             ❌ No existe
└── /api/webhooks/ses         ❌ No existe
```

---

## 3. Mapa completo del sistema

```
                    ┌─────────────────────────────────────┐
                    │           AWS SES                   │
                    │  Detecta bounce o spam complaint     │
                    └─────────────────┬───────────────────┘
                                      │ Publica evento
                                      ▼
                    ┌─────────────────────────────────────┐
                    │         AWS SNS Topic               │
                    │  (sendix-email-notifications)       │
                    └─────────────────┬───────────────────┘
                                      │ HTTP POST
                                      ▼
                    ┌─────────────────────────────────────┐
                    │   POST /api/webhooks/ses            │
                    │   (backend SendIX)                  │
                    │                                     │
                    │  1. Verificar firma SNS             │
                    │  2. Parsear tipo de evento          │
                    │  3. Registrar en bounce_events      │
                    │  4. Agregar a suppression_list      │
                    │  5. Actualizar status en messages   │
                    └─────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
                    │   Antes de cada envío               │
                    │   smtp-email.service.ts             │
                    │                                     │
                    │  ¿El destinatario está en           │
                    │   suppression_list?                 │
                    │   → SÍ: omitir, log 'suppressed'   │
                    │   → NO: continuar envío             │
                    └─────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
                    │   GET /unsubscribe?token=xxx        │
                    │   (ruta pública, sin auth)          │
                    │                                     │
                    │  1. Decodificar token               │
                    │  2. Agregar a suppression_list      │
                    │     reason: 'unsubscribed'          │
                    │  3. Mostrar página de confirmación  │
                    └─────────────────────────────────────┘
```

---

## Parte 1 — Migraciones de base de datos

### Por qué

Necesitas tres tablas nuevas que no existen hoy: el log de eventos de bounce/queja, la lista de supresión global, y los tokens de unsubscribe por email.

### Migración 1 — Tabla bounce_events

Registro de auditoría de cada evento recibido de SES. Sirve para debugging y para cumplimiento (puedes demostrar cuándo recibiste un bounce y qué hiciste con él).

```sql
CREATE TABLE bounce_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  -- 'hard_bounce' | 'soft_bounce' | 'complaint' | 'delivery'
  bounce_type   TEXT,
  -- Para bounces: 'Permanent' | 'Transient' | 'Undetermined'
  bounce_subtype TEXT,
  -- Para quejas: 'abuse' | 'auth-failure' | 'fraud' | 'not-spam' | 'other' | 'virus'
  complaint_feedback_type TEXT,
  message_id    TEXT,
  -- El Message-ID del correo que generó el evento
  sns_message_id TEXT,
  -- ID único del mensaje SNS, para deduplicación
  raw_payload   JSONB,
  -- El payload completo de SNS para auditoría
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bounce_events_email ON bounce_events(email);
CREATE INDEX idx_bounce_events_type ON bounce_events(event_type, created_at DESC);
CREATE UNIQUE INDEX idx_bounce_events_sns_id ON bounce_events(sns_message_id);
-- El índice único en sns_message_id previene procesar el mismo evento dos veces
```

### Migración 2 — Tabla suppression_list

La lista de emails que nunca deben recibir correos. Es global por organización/usuario, no por campaña.

```sql
CREATE TABLE suppression_list (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
  -- NULL = supresión global de la plataforma (hard bounce, complaint)
  -- UUID = supresión solo para ese usuario (unsubscribe de sus campañas)
  reason      TEXT NOT NULL,
  -- 'hard_bounce' | 'soft_bounce_repeated' | 'complaint' | 'unsubscribed' | 'manual'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(email, user_id)
  -- Un email puede estar suprimido globalmente (user_id NULL)
  -- Y también suprimido para un usuario específico
);

CREATE INDEX idx_suppression_email ON suppression_list(email);
CREATE INDEX idx_suppression_user ON suppression_list(user_id);

-- RLS: un usuario solo puede ver su propia suppression list
ALTER TABLE suppression_list ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own suppressions" ON suppression_list
  FOR SELECT USING (
    auth.uid() = user_id OR user_id IS NULL
  );

CREATE POLICY "Service role full access" ON suppression_list
  USING (true) WITH CHECK (true);
-- La política de service_role ya cubre el backend
```

### Migración 3 — Tabla unsubscribe_tokens

Tokens firmados que se incluyen en cada email masivo para identificar al destinatario sin exponer su email en la URL.

```sql
CREATE TABLE unsubscribe_tokens (
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

CREATE INDEX idx_unsubscribe_token ON unsubscribe_tokens(token);
CREATE INDEX idx_unsubscribe_email ON unsubscribe_tokens(email, user_id);
```

### Migración 4 — Soft bounce tracking en messages

Para detectar emails con rebotes repetidos (soft bounces acumulados = hard bounce efectivo).

```sql
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS soft_bounce_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_bounce_at TIMESTAMPTZ;
```

### Checklist Parte 1

- [ ] Ejecutar Migración 1 (`bounce_events`) en Supabase SQL Editor
- [ ] Ejecutar Migración 2 (`suppression_list`) y verificar que RLS queda activo
- [ ] Ejecutar Migración 3 (`unsubscribe_tokens`)
- [ ] Ejecutar Migración 4 (campos en `messages`)
- [ ] Confirmar que los índices se crearon correctamente (`\d bounce_events` en el editor)
- [ ] Verificar que la política de service_role del backend puede escribir en todas las tablas nuevas

---

## Parte 2 — Configuración de SNS en AWS

### Por qué

SES no envía notificaciones de bounce directamente a tu backend. Las publica en un topic de SNS (Simple Notification Service), que luego hace HTTP POST a tu endpoint. Esta indirección permite reintentos automáticos si tu backend está caído.

### Pasos en la consola de AWS

**Paso 1 — Crear el SNS Topic**

```
AWS Console → SNS → Topics → Create topic
Tipo: Standard (no FIFO)
Nombre: sendix-email-notifications
```

Guardar el ARN del topic: `arn:aws:sns:us-east-1:XXXXXXXXXXXX:sendix-email-notifications`

**Paso 2 — Suscribir tu endpoint al topic**

```
SNS → Topic → Create subscription
Protocol: HTTPS
Endpoint: https://tu-backend.railway.app/api/webhooks/ses
```

Cuando crees la suscripción, SNS enviará una solicitud de confirmación con una URL. Tu webhook debe responder a esa URL para activar la suscripción (ver Parte 3, manejo de `SubscriptionConfirmation`).

**Paso 3 — Conectar SES al topic SNS**

```
SES Console → Verified identities → tu dominio (sendix.com)
→ Notifications tab
→ Edit:
  Bounce notifications: sendix-email-notifications (el topic creado)
  Complaint notifications: sendix-email-notifications (el mismo topic)
  Delivery notifications: sendix-email-notifications (opcional, genera mucho volumen)
→ Activar "Include original headers" en bounces y quejas
```

**Paso 4 — Política del topic SNS**

El topic necesita permiso para que SES publique en él. En SNS → Topic → Edit → Access policy, agregar:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Service": "ses.amazonaws.com"
    },
    "Action": "SNS:Publish",
    "Resource": "arn:aws:sns:us-east-1:XXXXXXXXXXXX:sendix-email-notifications"
  }]
}
```

### Checklist Parte 2

- [ ] Crear el SNS Topic `sendix-email-notifications` en la misma región que SES
- [ ] Crear la suscripción HTTPS apuntando a `https://backend.railway.app/api/webhooks/ses`
- [ ] Confirmar la suscripción una vez que el webhook esté deployado (SNS reintenta cada hora si no se confirma)
- [ ] Conectar SES al topic para Bounce y Complaint en la configuración del dominio verificado
- [ ] Agregar la política de acceso al topic para permitir publicación desde SES
- [ ] Guardar el ARN del topic en una variable de entorno `SNS_TOPIC_ARN`

---

## Parte 3 — Webhook receptor de notificaciones SNS

### Qué hay que hacer

Crear el endpoint `POST /api/webhooks/ses` que recibe, valida y procesa todos los eventos de SES: bounces, quejas, entregas y la confirmación inicial de suscripción de SNS.

### Estructura del payload SNS

SNS envía siempre un wrapper con este formato:

```json
{
  "Type": "Notification",            // o "SubscriptionConfirmation"
  "MessageId": "uuid-del-mensaje",
  "TopicArn": "arn:aws:sns:...",
  "Message": "{...json como string...}",
  "Timestamp": "2026-05-27T00:00:00.000Z",
  "SignatureVersion": "1",
  "Signature": "base64...",
  "SigningCertURL": "https://sns.amazonaws.com/..."
}
```

Cuando `Type = "SubscriptionConfirmation"`, el payload tiene `SubscribeURL` que debes hacer GET para confirmar la suscripción.

Cuando `Type = "Notification"`, el campo `Message` es un string JSON que hay que parsear. Dentro está el evento de SES:

```json
{
  "notificationType": "Bounce",    // "Bounce" | "Complaint" | "Delivery"
  "bounce": {
    "bounceType": "Permanent",     // "Permanent" | "Transient" | "Undetermined"
    "bounceSubType": "General",
    "bouncedRecipients": [
      { "emailAddress": "usuario@ejemplo.com", "status": "5.1.1" }
    ]
  },
  "mail": {
    "messageId": "el-message-id-original",
    "destination": ["usuario@ejemplo.com"]
  }
}
```

### Lógica completa del webhook

```
POST /api/webhooks/ses:

1. Verificar firma SNS:
   - Descargar el certificado de SigningCertURL (solo si el dominio es amazonaws.com)
   - Verificar la firma del mensaje con RSA
   - Si falla → responder 400, ignorar

2. Si Type === "SubscriptionConfirmation":
   - Hacer GET al SubscribeURL
   - Responder 200

3. Si Type === "Notification":
   a. Parsear Message (string JSON)
   b. Verificar deduplicación: ¿ya existe bounce_events con este sns_message_id?
      → Si ya existe → responder 200 (idempotencia, SNS reintenta)
   c. Según notificationType:

   "Bounce":
     - Si bounceType === "Permanent":
         → Insertar en bounce_events (event_type: 'hard_bounce')
         → Insertar en suppression_list (reason: 'hard_bounce', user_id: NULL)
         → UPDATE messages SET status = 'bounced', last_bounce_at = NOW()
     - Si bounceType === "Transient":
         → Insertar en bounce_events (event_type: 'soft_bounce')
         → UPDATE messages SET soft_bounce_count += 1, last_bounce_at = NOW()
         → Si soft_bounce_count >= 3:
             → Insertar en suppression_list (reason: 'soft_bounce_repeated', user_id: NULL)

   "Complaint":
     → Insertar en bounce_events (event_type: 'complaint')
     → Insertar en suppression_list (reason: 'complaint', user_id: NULL)
     → UPDATE messages SET status = 'complained'

   "Delivery":
     → UPDATE messages SET status = 'delivered'
     (opcional, genera mucho volumen — considerar solo loguear sin escribir a BD)

4. Responder 200 siempre al final (aunque haya un error interno, para que SNS no reintente indefinidamente)
5. Loguear errores internos sin retornar 5xx a SNS
```

### Verificación de firma SNS — importante

SNS puede ser suplantado si no verificas la firma. La librería `sns-validator` de npm simplifica esto (preguntar antes de instalar). La verificación manual requiere:

1. Construir el string a verificar concatenando campos específicos del payload en orden fijo
2. Descargar el certificado X.509 desde `SigningCertURL` (solo si el dominio termina en `.amazonaws.com`, para evitar SSRF)
3. Verificar la firma RSA-SHA1 con `crypto.verify`

### Archivo a crear

```
backend/src/routes/webhooks-ses.route.ts
backend/src/services/bounce.service.ts
```

### Checklist Parte 3

- [ ] Crear `backend/src/services/bounce.service.ts` con las funciones `handleBounce`, `handleComplaint`, `handleDelivery`
- [ ] Implementar la lógica de deduplicación por `sns_message_id` antes de procesar
- [ ] Implementar la verificación de firma SNS (preguntar si instalar `sns-validator` o implementar manualmente)
- [ ] Crear `backend/src/routes/webhooks-ses.route.ts` con el endpoint POST
- [ ] Montar la ruta en `server.ts` — **sin** el middleware `authApiKey` (es un webhook público)
- [ ] Manejar el `SubscriptionConfirmation` haciendo GET al `SubscribeURL`
- [ ] Implementar la lógica de soft bounce acumulado (3 soft bounces → suppression)
- [ ] Verificar que `INSERT OR IGNORE` en `suppression_list` maneja duplicados sin errores (usar `ON CONFLICT DO NOTHING`)
- [ ] Responder siempre 200 a SNS para evitar reintentos en errores internos; loguear el error internamente
- [ ] Deployar el endpoint antes de confirmar la suscripción SNS (el endpoint debe estar vivo para responder al `SubscriptionConfirmation`)

---

## Parte 4 — Suppression list: verificación antes de envío

### Qué hay que hacer

Modificar `smtp-email.service.ts` para que antes de enviar cualquier correo (individual o bulk), consulte la `suppression_list` y omita los destinatarios suprimidos.

### Lógica del dispatcher actualizado

```
sendEmail(userId, payload):

1. Normalizar email a minúsculas (evitar case-sensitivity issues)

2. Verificar suppression:
   SELECT id FROM suppression_list 
   WHERE email = lower(payload.to)
   AND (user_id = userId OR user_id IS NULL)
   LIMIT 1

3. Si suprimido:
   → NO enviar
   → Registrar en messages con status = 'suppressed'
   → Retornar { suppressed: true, reason: suppression.reason }

4. Si no suprimido → continuar con el flujo normal de envío
```

### Para envíos bulk

En `send.route.ts`, el bulk procesa por batches. Antes de cada batch, filtrar los emails suprimidos del batch completo en una sola query:

```
SELECT email FROM suppression_list
WHERE email = ANY($1::text[])          -- $1 = array de todos los emails del batch
AND (user_id = $2 OR user_id IS NULL)  -- $2 = userId
```

Retornar dos arrays: `toSend` y `suppressed`. Los suprimidos se loguean sin intentar el envío.

### Checklist Parte 4

- [ ] Agregar función `isEmailSuppressed(email, userId)` en un nuevo `suppression.service.ts`
- [ ] Agregar función `filterSuppressedEmails(emails[], userId)` para bulk (una sola query con `ANY`)
- [ ] Modificar `smtp-email.service.ts` para llamar a `isEmailSuppressed` antes de `transporter.sendMail`
- [ ] Modificar el handler de bulk en `send.route.ts` para filtrar con `filterSuppressedEmails` antes de cada batch
- [ ] Registrar los emails suprimidos en `messages` con `status = 'suppressed'` (para que aparezcan en los logs del usuario)
- [ ] El contador `emails_sent_this_month` NO debe incrementarse para emails suprimidos
- [ ] Agregar normalización de email a minúsculas en todos los puntos de inserción y consulta

---

## Parte 5 — Mecanismo de unsubscribe

### Qué hay que hacer

Tres cosas relacionadas:
1. Generar un token de unsubscribe único para cada email que se envía en campañas masivas
2. Inyectar el link de baja en el footer de cada email masivo
3. Crear el endpoint público que procesa la baja y muestra la confirmación

### Generación del token

El token debe ser opaco (no decodificable sin la BD) y con tiempo de expiración. Usar `crypto.randomBytes(32).toString('hex')` — 64 caracteres hexadecimales, imposibles de adivinar.

```
generateUnsubscribeToken(email, userId, campaignId?):
1. token = crypto.randomBytes(32).toString('hex')
2. INSERT INTO unsubscribe_tokens (token, email, user_id, campaign_id, expires_at)
   VALUES (token, email, userId, campaignId, NOW() + INTERVAL '1 year')
3. Retornar token
```

### Inyección en el email

Antes de llamar a `transporter.sendMail()`, el servicio de email debe agregar el footer de baja al HTML. Esto aplica **solo a envíos masivos** (bulk), no a emails transaccionales individuales.

```html
<!-- Footer mínimo de unsubscribe — agregar al final del HTML del email -->
<div style="text-align:center;margin-top:32px;font-size:12px;color:#888;">
  Si no deseas recibir más correos de este remitente,
  <a href="https://api.sendix.com/unsubscribe?token={{TOKEN}}">
    haz clic aquí para darte de baja
  </a>
</div>
```

El dominio del link de unsubscribe es siempre el backend de SendIX, no el dominio del cliente. Esto es importante: el endpoint de baja es infraestructura de SendIX, no del cliente.

### Endpoint de unsubscribe

```
GET /unsubscribe?token=xxxxxxxx

1. SELECT * FROM unsubscribe_tokens WHERE token = $1
2. Si no existe → mostrar página de error "Link inválido"
3. Si expires_at < NOW() → mostrar página de error "Link expirado"
4. Si used_at IS NOT NULL → mostrar página "Ya estás dado de baja" (idempotente)
5. Si válido:
   a. UPDATE unsubscribe_tokens SET used_at = NOW() WHERE token = $1
   b. INSERT INTO suppression_list 
      (email, user_id, reason) 
      VALUES (token.email, token.user_id, 'unsubscribed')
      ON CONFLICT DO NOTHING
   c. Mostrar página HTML de confirmación
```

### Página de confirmación

El endpoint debe retornar HTML directamente (no JSON). Es una página pública accesible sin auth:

```
HTTP 200
Content-Type: text/html

Página simple con:
- Logo de SendIX
- Mensaje: "Te has dado de baja correctamente"
- Submensaje: "No recibirás más correos de [nombre del remitente]"
- Sin links ni navegación adicional
```

### Header List-Unsubscribe (buenas prácticas de email)

Gmail, Outlook y otros clientes de email muestran un botón de "Cancelar suscripción" nativo si el email incluye el header `List-Unsubscribe`. Esto reduce las quejas porque los usuarios usan ese botón en lugar de marcar como spam.

Agregar en `sendMail()` para envíos bulk:

```
List-Unsubscribe: <https://api.sendix.com/unsubscribe?token=TOKEN>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

El header `List-Unsubscribe-Post` activa el unsubscribe con un solo clic desde Gmail sin que el usuario tenga que visitar la página.

### Checklist Parte 5

- [ ] Crear `backend/src/services/unsubscribe.service.ts` con `generateUnsubscribeToken` y `processUnsubscribe`
- [ ] Generar el token en `smtp-email.service.ts` para cada destinatario de envíos bulk antes de llamar a `sendMail`
- [ ] Implementar la función que inyecta el footer HTML con el link personalizado por destinatario
- [ ] Crear `backend/src/routes/unsubscribe.route.ts` con el endpoint `GET /unsubscribe`
- [ ] Montar la ruta **sin** middleware `authApiKey` ni ninguna autenticación
- [ ] Implementar la página HTML de confirmación (puede ser un template string en el servicio)
- [ ] Agregar los headers `List-Unsubscribe` y `List-Unsubscribe-Post` en `sendMail` para bulk
- [ ] Manejar el endpoint como idempotente: si el token ya fue usado, mostrar confirmación sin error
- [ ] Verificar que el token generado se guarda en BD antes de intentar el envío (si el envío falla, el token queda en BD pero sin email enviado — aceptable)
- [ ] Para envíos transaccionales individuales (no bulk): no inyectar el footer ni generar token

---

## Parte 6 — Dashboard: visibilidad de bounces y bajas

### Qué hay que hacer

Los usuarios Pro/Agency necesitan ver el estado de sus envíos y gestionar su suppression list desde el dashboard.

### Cambios en /dashboard/logs

Agregar columna de estado con los nuevos valores:

| Status | Color | Significado |
|--------|-------|-------------|
| `delivered` | Verde | Entregado correctamente |
| `bounced` | Rojo | Hard bounce — email inválido |
| `complained` | Naranja | El destinatario marcó como spam |
| `suppressed` | Gris | Omitido por estar en suppression list |
| `soft_bounce` | Amarillo | Rebote temporal |

### Nueva página /dashboard/suppression

Tabla paginada con los emails suprimidos del usuario con:
- Email suprimido
- Razón (`hard_bounce`, `complaint`, `unsubscribed`, `manual`)
- Fecha de supresión
- Botón para eliminar manualmente (si el usuario está seguro de que quiere reintentar)

⚠️ **Regla de negocio:** El usuario puede eliminar entradas con `reason = 'unsubscribed'` o `reason = 'soft_bounce_repeated'`. Las entradas con `reason = 'hard_bounce'` o `reason = 'complaint'` y `user_id = NULL` (supresiones globales de la plataforma) no pueden eliminarse desde el dashboard de usuario.

### Nuevos endpoints necesarios

```
GET  /api/suppression          → Lista paginada de emails suprimidos del usuario
DELETE /api/suppression/:email → Eliminar supresión (solo si user_id = userId del request)
GET  /api/bounces/stats        → Métricas: total bounces, bounce rate, complaint rate del mes
```

### Checklist Parte 6

- [ ] Actualizar el componente de logs en `/dashboard/logs` para mostrar los nuevos estados con colores correctos
- [ ] Crear la página `/dashboard/suppression` con tabla paginada
- [ ] Implementar el endpoint `GET /api/suppression` con paginación y filtro por `user_id`
- [ ] Implementar el endpoint `DELETE /api/suppression/:email` con validación de que solo borra las propias
- [ ] Crear el endpoint `GET /api/bounces/stats` que calcule bounce rate y complaint rate del mes actual
- [ ] Agregar `lib/api.ts` helpers tipados para los tres endpoints nuevos
- [ ] Agregar el link a Suppression en el sidebar del dashboard

---

## Variables de entorno adicionales

```bash
# Backend .env — agregar a las existentes

# SNS — para verificar firmas del webhook
SNS_TOPIC_ARN=arn:aws:sns:us-east-1:XXXXXXXXXXXX:sendix-email-notifications

# Unsubscribe — URL pública del backend para construir los links
PUBLIC_API_URL=https://tu-backend.railway.app
# Se usa para: https://tu-backend.railway.app/unsubscribe?token=xxx
```

---

## Orden de implementación y dependencias

```
Parte 1 (Migraciones DB)
        │
        ├──► Parte 3 (Webhook SNS)      ← necesita bounce_events y suppression_list
        │         │
        │         └──► Parte 2 (Config SNS en AWS)  ← el endpoint debe estar vivo primero
        │
        ├──► Parte 4 (Verificación suppression en envío)  ← necesita suppression_list
        │
        ├──► Parte 5 (Unsubscribe)      ← necesita unsubscribe_tokens y suppression_list
        │
        └──► Parte 6 (Dashboard)        ← necesita todo lo anterior funcionando
```

**Orden recomendado de sprints:**

| Sprint | Partes | Resultado |
|--------|--------|-----------|
| 1 | Parte 1 | Base de datos lista |
| 2 | Parte 3 + Parte 2 | Bounces y quejas procesándose automáticamente |
| 3 | Parte 4 | Supresión aplicada antes de cada envío |
| 4 | Parte 5 | Unsubscribe funcionando con footer en emails masivos |
| 5 | Parte 6 | Visibilidad completa en el dashboard |

---

## Umbrales de SES y alertas

### Métricas a monitorear continuamente

Configurar alertas en AWS CloudWatch para recibir notificación antes de llegar a los umbrales de suspensión:

```
Alerta 1: Bounce rate > 1.5%   → Email a admin (zona de advertencia)
Alerta 2: Bounce rate > 3%     → Email urgente + suspender envíos del usuario afectado
Alerta 3: Complaint rate > 0.05% → Email urgente
```

En el dashboard de SendIX, mostrar el bounce rate y complaint rate del mes actual para que el propio usuario vea su estado de reputación.

### Acciones automáticas recomendadas

Si un usuario supera 5% de bounce rate en sus últimos 1,000 envíos, bloquear automáticamente sus nuevos envíos y notificarle por email para que limpie su lista de contactos. Desbloquearlo manualmente solo después de que revierta la situación.

### Google Postmaster Tools

Registrar el dominio `sendix.com` (el dominio compartido del plan Free) en Google Postmaster Tools. Es gratuito y muestra cómo Gmail percibe la reputación del dominio — el principal cliente de email del mundo.

```
https://postmaster.google.com
→ Add domain → sendix.com
→ Verificar con un registro TXT en DNS
```
