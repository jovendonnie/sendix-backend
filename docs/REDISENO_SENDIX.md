# SendIX — Rediseño Completo de Producto
### Combinación de Propuesta 1 (Orquestación) + Propuesta 3 (Observabilidad)

---

## Nueva Visión del Producto

SendIX deja de ser una plataforma que envía correos. Se convierte en la **capa de inteligencia que vive entre el developer y sus proveedores de email**.

El developer no le da sus emails a SendIX para que los envíe. Le da a SendIX sus propias API keys de Resend, Brevo, AWS SES o cualquier proveedor, y SendIX se convierte en el cerebro de toda esa operación: decide por qué proveedor sale cada email, reintenta si falla, registra cada evento que regresa, y expone todo eso en una UI clara y en una API que el developer puede consumir.

**En una línea:** SendIX es el sistema nervioso del email, no el cartero.

---

## Lo Que Desaparece Completamente

Estos son los conceptos, rutas y vistas que dejan de existir en SendIX:

- **Envío masivo (bulk)** desde la UI de la SaaS — no hay más carga de CSV ni envíos a listas.
- **La página `/dashboard/send`** como formulario para redactar y enviar un correo desde SendIX.
- **El concepto de que SendIX tiene un proveedor de email propio.** Resend pasa de ser "el proveedor de SendIX" a ser "uno de los proveedores que el developer puede conectar".
- **La dependencia hardcodeada a Resend** en el backend. `RESEND_API_KEY` como variable de entorno global del servidor desaparece.
- **La ruta `POST /api/send/bulk`** y toda su lógica de batching con delays.
- **La tabla `jobs`** en Supabase en su forma actual (se reemplaza por una tabla de eventos de orquestación).
- **El editor TipTap** en el dashboard — ya no hay redacción de correos desde la UI.

---

## Nueva Arquitectura Conceptual

El producto tiene ahora dos pilares que se complementan:

### Pilar 1 — Orquestación de Envío

El developer conecta sus proveedores de email en SendIX usando sus propias API keys. Cuando su aplicación necesita enviar un correo, llama a la API de SendIX con la API key de SendIX (no la de Resend). SendIX recibe esa instrucción, elige el proveedor correcto según la configuración del developer, ejecuta el envío, maneja reintentos si el proveedor falla, y registra el resultado.

El developer tiene un único punto de integración. Los proveedores son intercambiables sin cambiar código en su aplicación.

### Pilar 2 — Observabilidad de Email

Cada proveedor de email genera eventos después del envío: entregado, rebotado, abierto, link clicado, marcado como spam, dado de baja. Normalmente esos eventos van a webhooks que el developer tiene que construir y mantener por su cuenta.

Con SendIX, el developer apunta todos sus webhooks de proveedor a un endpoint único de SendIX. SendIX recibe esos eventos, los normaliza a un formato estándar sin importar de qué proveedor vienen, los almacena, los muestra en el dashboard, y los expone en una API para que el developer los consuma desde su propia aplicación.

---

## Cambios en el Backend

### Servicios que desaparecen o se transforman

**`email.service.ts` — se transforma completamente**

Deja de ser un wrapper de Resend. Se convierte en `orchestrator.service.ts`. Su responsabilidad es:
- Recibir una instrucción de envío.
- Consultar qué proveedores tiene configurados el developer (de Supabase).
- Elegir el proveedor activo según la configuración (prioridad, fallback).
- Llamar al adapter del proveedor correspondiente.
- Si el envío falla, aplicar la lógica de reintento con backoff y, si hay fallback configurado, intentar con el siguiente proveedor.
- Registrar el resultado en la tabla `messages`.

**`message.service.ts` — se extiende**

Sigue registrando envíos, pero ahora también registra eventos de observabilidad normalizados que llegan por webhook.

**Nuevo: `provider.service.ts`**

Maneja toda la lógica de los proveedores del developer: guardar sus API keys de proveedor (encriptadas, nunca en texto plano), validar que una API key de proveedor funciona, listar los proveedores activos de un developer y su configuración de prioridad/fallback.

**Nuevo: `webhook.service.ts`**

Recibe eventos crudos de proveedores (Resend, Brevo, etc.), los parsea según el formato de cada proveedor, los normaliza a la estructura interna de SendIX, y los persiste. También valida las firmas de webhook de cada proveedor para evitar eventos falsos.

**Nuevo: `event.service.ts`**

Expone los eventos normalizados almacenados hacia la API pública de SendIX, con filtros por email, por tipo de evento, por proveedor, por rango de fechas.

---

### Rutas del Backend — Cambios Específicos

#### Rutas que desaparecen

```
DELETE  POST /api/send/bulk        — envío masivo, se elimina
```

#### Rutas que cambian

```
POST /api/send
```
Esta ruta mantiene su contrato externo (el developer sigue llamando aquí para enviar un email), pero la lógica interna cambia completamente. Ya no llama a Resend directamente. Llama a `orchestrator.service.ts` que determina el proveedor, ejecuta el envío, y maneja reintentos. La respuesta al developer sigue siendo la misma: confirmación del envío con un `message_id`.

#### Rutas nuevas

```
GET    /api/providers              — lista los proveedores conectados del developer
POST   /api/providers              — conecta un nuevo proveedor (Resend, Brevo, SES, etc.)
PUT    /api/providers/:id          — actualiza configuración (prioridad, fallback, activo/inactivo)
DELETE /api/providers/:id          — desconecta un proveedor
POST   /api/providers/:id/validate — verifica que la API key del proveedor funciona

POST   /api/webhooks/ingest/:userId  — endpoint público que recibe eventos de proveedores
GET    /api/events                   — lista eventos normalizados (con filtros)
GET    /api/events/:messageId        — historial completo de eventos de un email específico
GET    /api/events/stats             — estadísticas agregadas: tasas de entrega, rebote, apertura
```

---

### Cambios en la Base de Datos (Supabase)

#### Tabla nueva: `providers`
Almacena los proveedores conectados de cada developer.

Columnas: `id`, `user_id`, `provider_name` (resend | brevo | ses | mailgun | postmark), `api_key_encrypted`, `priority` (número entero, menor = mayor prioridad), `is_fallback` (boolean), `is_active` (boolean), `created_at`.

La API key del proveedor se encripta antes de guardar — nunca en texto plano, similar al tratamiento de las API keys de SendIX.

#### Tabla `messages` — nuevas columnas
Se añaden: `provider_used` (cuál proveedor ejecutó el envío), `retry_count` (cuántos reintentos tomó), `final_status` (success | failed | fallback_used), `provider_message_id` (el ID que devolvió el proveedor, para cruzar con eventos de webhook).

#### Tabla nueva: `email_events`
Almacena cada evento normalizado recibido por webhook.

Columnas: `id`, `user_id`, `message_id` (FK a messages), `provider_message_id`, `provider_name`, `event_type` (delivered | bounced | opened | clicked | complained | unsubscribed), `occurred_at` (timestamp del proveedor), `raw_payload` (JSONB con el evento original), `metadata` (JSONB con datos del evento normalizado: URL clicada, tipo de rebote, etc.), `created_at`.

#### Tabla `jobs` — se elimina
La tabla de jobs de envío masivo desaparece. El concepto de "job de envío masivo" no existe en el nuevo modelo.

---

## Cambios en el Frontend

### Páginas que desaparecen

**`/dashboard/send`** — La página de redacción y envío de correos desde la UI se elimina. SendIX ya no es una herramienta para redactar y enviar emails manualmente.

### Páginas que cambian completamente

**`/dashboard/logs`** pasa a llamarse **`/dashboard/events`**

Deja de ser una tabla simple de "emails enviados". Se convierte en el centro de observabilidad. Muestra:
- Todos los eventos normalizados recibidos (delivered, bounced, opened, etc.)
- Filtros por tipo de evento, por proveedor, por rango de fechas, por email de destinatario
- Al hacer clic en un email específico, se abre un panel lateral que muestra la línea de tiempo completa de ese correo: enviado → entregado → abierto → link clicado
- Indicadores visuales de estado: verde (entregado), rojo (rebote duro), naranja (rebote suave), gris (pendiente)

**`/dashboard/analytics`**

Cambia de métricas de volumen de envío a métricas de salud del email:
- Tasa de entrega por proveedor
- Tasa de rebote por proveedor y por dominio de destinatario
- Tasa de apertura y clics (si el proveedor los reporta)
- Tendencia de quejas de spam
- Comparativa entre proveedores (si hay más de uno conectado)

**`/dashboard/settings`**

Añade una sección de **Webhook Endpoint** donde el developer puede copiar su URL única de SendIX para configurarla en cada proveedor. Ejemplo: `https://app.sendix.dev/api/webhooks/ingest/usr_xxxx`. También muestra instrucciones específicas de cómo configurarlo en Resend, Brevo y AWS SES.

### Páginas nuevas

**`/dashboard/providers`**

Vista central del nuevo modelo. El developer ve aquí todos sus proveedores conectados con su estado (activo/inactivo), su prioridad de uso, y si está configurado como fallback. Puede:
- Conectar un nuevo proveedor: selecciona el tipo (Resend, Brevo, SES, Mailgun, Postmark) y pega su API key
- Ver si la API key es válida (botón de validar que llama a `POST /api/providers/:id/validate`)
- Cambiar el orden de prioridad arrastrando los proveedores
- Marcar uno como fallback
- Desconectar un proveedor

La UI de esta vista sigue el mismo lenguaje visual del dashboard actual: dark mode base, tarjetas con opacidad, mismos componentes de botón y tabla.

**`/dashboard/send` se reemplaza por `/dashboard/test-send`** (opcional, para developers)

Una herramienta de prueba simplificada: envía un email a una dirección de prueba usando la configuración de orquestación activa. Sirve para que el developer verifique que sus proveedores están bien conectados antes de integrar el SDK. No es una herramienta de envío masivo — es un debugger. Esta vista podría estar dentro de `/dashboard/providers` como una acción secundaria.

---

### Cambios en el Sidebar

El sidebar del dashboard refleja la nueva estructura:

```
Antes:
- Overview
- Send           ← desaparece
- Logs
- API Keys
- Analytics
- Domains
- Settings

Después:
- Overview
- Providers      ← nuevo
- Events         ← renombrado desde Logs, rediseñado
- API Keys       ← sin cambios
- Analytics      ← rediseñado
- Settings       ← con nueva sección de webhook endpoint
```

---

### Cambios en el Overview

El dashboard principal cambia sus métricas. Deja de mostrar "emails enviados este mes" como métrica principal y muestra:

- Estado de los proveedores conectados (cuántos activos, si alguno tiene un error)
- Tasa de entrega de las últimas 24 horas
- Emails en vuelo (enviados pero sin confirmación de entrega aún)
- Últimos eventos de rebote (para acción inmediata)
- Volumen de eventos recibidos por webhook en los últimos 7 días

---

## Nueva API para Developers — Lo Que Consume el Developer

Este es el contrato final que tiene el developer con SendIX. Todo lo demás es interno.

### Autenticación
Sin cambios. API key de SendIX en el header `Authorization: Bearer sk_live_xxxx`. La API key se genera desde `/dashboard/api-keys` igual que antes.

### Envío orquestado
```
POST /api/send
{
  "from": "hola@tudominio.com",
  "to": "cliente@ejemplo.com",
  "subject": "Confirmación de compra",
  "html": "<p>Tu pedido fue confirmado.</p>",
  "idempotency_key": "order_8821_confirmation"  ← nuevo campo opcional
}
```

El developer llama exactamente igual que antes. La diferencia es lo que pasa por dentro: SendIX usa sus proveedores conectados, maneja reintentos, y registra el resultado. Si el developer envía el mismo `idempotency_key` dos veces, SendIX devuelve el resultado del primero sin duplicar el envío.

Respuesta:
```json
{
  "message_id": "msg_xxxx",
  "provider_used": "resend",
  "status": "sent"
}
```

### Consulta de eventos
```
GET /api/events?message_id=msg_xxxx
GET /api/events?event_type=bounced&from=2026-06-01&to=2026-06-10
GET /api/events/stats?period=7d
```

El developer puede consultar en tiempo real qué pasó con cualquier email que envió. Puede integrar esto en su propio dashboard interno, en sus alertas, o en su sistema de soporte para responder a usuarios que reportan no haber recibido un correo.

### Gestión de proveedores (opcional desde código)
```
GET    /api/providers
POST   /api/providers
DELETE /api/providers/:id
```

El developer puede gestionar sus proveedores programáticamente si prefiere no usar la UI. Útil para equipos que gestionan múltiples proyectos desde código o CI/CD.

---

## SDK — Lo Que Cambia

El SDK de SendIX (cuando se construya) expone lo mismo que la API pero con una DX mejorada para Node.js, Python y otros lenguajes que sean prioritarios.

Lo que el developer escribiría en su aplicación:

```typescript
import { SendIX } from '@sendix/sdk'

const sendix = new SendIX({ apiKey: process.env.SENDIX_API_KEY })

// Envío con idempotency automático
const result = await sendix.send({
  from: 'hola@tudominio.com',
  to: 'usuario@ejemplo.com',
  subject: 'Tu código de verificación',
  html: '<p>Tu código es: 8821</p>',
  idempotencyKey: `verify_${userId}_${Date.now()}`
})

// Consultar qué pasó con ese email
const events = await sendix.events.getByMessage(result.messageId)

// Estadísticas
const stats = await sendix.events.getStats({ period: '7d' })
console.log(stats.deliveryRate) // 98.4
console.log(stats.bounceRate)   // 0.8
```

El developer no sabe ni le importa si por debajo se usó Resend o Brevo. Eso es decisión de su configuración en el dashboard. Si mañana quiere cambiar de proveedor, lo hace en el dashboard sin tocar una sola línea de código en su aplicación.

---

## Lo Que el Developer Termina Consumiendo — Conclusión

El developer integra **una sola API key** y **un solo SDK**. A cambio obtiene:

**Del Pilar de Orquestación:**
- Sus emails salen por el proveedor que él eligió, configurado en su dashboard
- Si ese proveedor falla, hay un fallback automático al siguiente
- Los reintentos con backoff se manejan solos — no necesita construir esa lógica
- Idempotency nativa — no hay correos duplicados por retries de red
- El proveedor que usa puede cambiar sin tocar el código de su app

**Del Pilar de Observabilidad:**
- Cada evento de cada email que envía (entregado, rebotado, abierto, etc.) llega a SendIX y queda disponible en la API
- Puede consultarlo desde su propia app para mostrar a su equipo de soporte qué pasó con el correo de un cliente
- Tiene estadísticas de salud de su email en tiempo real: tasa de entrega, rebotes, quejas
- Si su tasa de rebote empieza a subir, lo ve antes de que el proveedor le suspenda la cuenta

**Lo que no tiene que construir:**
- Webhook handlers para normalizar eventos de Resend, Brevo o SES (formatos diferentes, todos caóticos)
- Lógica de retry con backoff
- Sistema de fallback entre proveedores
- Almacenamiento de historial de eventos de email
- Dashboard de observabilidad para su equipo

Todo eso es SendIX.

---

## Resumen de Todos los Cambios por Área

### Backend
| Componente | Acción |
|---|---|
| `email.service.ts` | Se transforma en `orchestrator.service.ts` |
| `message.service.ts` | Se extiende con columnas nuevas y soporte a eventos |
| `send.route.ts` | Se elimina la ruta `/bulk`, la ruta `/send` cambia su lógica interna |
| Nuevo `provider.service.ts` | CRUD de proveedores del developer |
| Nuevo `webhook.service.ts` | Ingesta y normalización de eventos |
| Nuevo `event.service.ts` | Exposición de eventos en la API pública |
| Nuevas rutas `/api/providers` | CRUD completo de proveedores |
| Nueva ruta `/api/webhooks/ingest/:userId` | Endpoint público de recepción de eventos |
| Nuevas rutas `/api/events` | Consulta de eventos y estadísticas |

### Base de Datos
| Tabla | Acción |
|---|---|
| `messages` | Se extiende con nuevas columnas |
| Nueva `providers` | Proveedores conectados por developer |
| Nueva `email_events` | Eventos normalizados de todos los proveedores |
| `jobs` | Se elimina |

### Frontend
| Elemento | Acción |
|---|---|
| `/dashboard/send` | Se elimina |
| `/dashboard/logs` | Se renombra a `/dashboard/events` y se rediseña |
| `/dashboard/analytics` | Se rediseña con métricas de salud |
| `/dashboard/settings` | Se añade sección de webhook endpoint |
| Nueva `/dashboard/providers` | Vista de gestión de proveedores conectados |
| Sidebar | Se actualiza con nueva estructura |
| Overview | Se rediseñan las métricas principales |
| Componente `editor.tsx` | Se elimina (TipTap) |

### Variables de Entorno del Backend
| Variable | Acción |
|---|---|
| `RESEND_API_KEY` | Se elimina como variable global del servidor |

---

*Documento de rediseño — SendIX, junio 2026. Todo lo descrito aquí es el qué y el dónde. La implementación técnica de cada punto se desarrolla por separado.*
