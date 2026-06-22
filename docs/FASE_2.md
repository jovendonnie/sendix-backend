# SendIX — Fase 2
### Automatización con n8n / Make / Zapier + Inteligencia en la Observabilidad

> **Prerequisito:** Todo lo descrito en `REDISENO_SENDIX.md` está implementado y en producción.
> Esta fase no modifica la arquitectura base — la extiende.

---

## Qué resuelve esta fase

La Fase 1 convierte a SendIX en la capa de orquestación y observabilidad del email para developers. El developer integra su API key, conecta sus proveedores, y tiene visibilidad de cada evento.

El problema que queda después de eso: **el developer tiene los datos, pero tiene que interpretar y actuar sobre ellos por su cuenta.** Un rebote es un log. Un patrón de rebotes es un problema. Un diagnóstico de ese problema en español es valor. Y cuando algo falla, el developer tiene que construir manualmente la reacción — actualizar el CRM, notificar al equipo, crear un ticket.

La Fase 2 resuelve esas dos cosas: **IA que convierte eventos crudos en diagnósticos accionables, y automatización nativa con las herramientas de workflow que los developers ya usan.**

---

## Pilar A — SendIX en el Ecosistema de Automatización

### Qué es

SendIX se integra como nodo nativo en n8n, Make y Zapier. El developer puede usar SendIX dentro de sus workflows existentes sin salir de la herramienta que ya usa para automatizar el resto de su stack.

### Dos direcciones de integración

**SendIX como acción (el workflow envía):**
El developer construye un workflow en n8n: cuando se confirma un pago en Stripe, cuando un usuario se registra en su app, cuando un ticket cambia de estado en Linear — el nodo de SendIX recibe esos datos y ejecuta el envío orquestado con toda la lógica de reintentos y fallback que ya tiene la Fase 1. El developer no necesita escribir código para conectar su workflow con SendIX.

**SendIX como trigger (el evento dispara el workflow):**
Cuando SendIX recibe un evento de webhook de un proveedor (email rebotado, email marcado como spam, link clicado), puede disparar un webhook hacia n8n, Make o Zapier. El developer construye la reacción: si un email rebota → marcar al usuario en el CRM → notificar al equipo de soporte en Slack → crear un ticket. SendIX se convierte en el origen del workflow, no solo en el destino.

### Qué se construye

**Nodo de n8n (community node):**
n8n acepta nodos creados por la comunidad. Se publica un paquete npm (`n8n-nodes-sendix`) que expone:
- **Acción: Send Email** — llama a `POST /api/send` con los campos mapeados desde el workflow
- **Acción: Get Events** — consulta `GET /api/events` con filtros para usarlos en el workflow
- **Trigger: Email Event** — escucha eventos de SendIX (delivered, bounced, complained, etc.) y dispara el workflow cuando ocurren

**Integración en Make (ex-Integromat):**
Make tiene un proceso de registro de módulos similar. Se construye un módulo con las mismas tres capacidades: Send, Get Events, Watch Events.

**Integración en Zapier:**
Zapier tiene un proceso de publicación de apps. Misma lógica: una acción (enviar email) y un trigger (cuando ocurre un evento).

### Cambios en el backend para soportar esto

**Nueva ruta: `POST /api/webhooks/outbound`**
Para que SendIX pueda disparar eventos hacia n8n/Make/Zapier, necesita un sistema de webhooks salientes. El developer configura en el dashboard qué eventos quiere recibir y a qué URL enviarlos. Esta ruta persiste esa configuración.

**Nueva tabla: `outbound_webhooks`**
Almacena las suscripciones de webhooks salientes: `user_id`, `url`, `events` (array de tipos de evento a escuchar), `secret` (para firmar los payloads), `is_active`.

**Nueva lógica en `webhook.service.ts`**
Después de procesar y normalizar un evento entrante de proveedor, el servicio verifica si el developer tiene webhooks salientes configurados para ese tipo de evento y los dispara con reintentos.

### Cambios en el dashboard

**Nueva sección en `/dashboard/settings`: Webhooks Salientes**
El developer puede registrar URLs de destino para sus webhooks salientes, seleccionar qué tipos de evento quiere recibir, ver el historial de entregas (exitosas y fallidas), y copiar el secret para validar las firmas en su lado.

**Nueva sección en `/dashboard/settings`: Integraciones**
Muestra links directos a los nodos de SendIX en el marketplace de n8n, Make y Zapier, con instrucciones de setup en español. No es técnico — es literalmente "haz clic aquí para instalar el nodo en tu workspace de n8n, luego pon tu API key".

---

## Pilar B — IA en la Observabilidad

### Qué es

SendIX ya tiene todos los eventos de email de sus developers. La IA convierte esos eventos en diagnósticos comprensibles y en alertas proactivas. El developer no necesita saber qué significa un código de error SMTP ni revisar logs manualmente — SendIX le dice qué está pasando y qué hacer.

### Feature 1 — Diagnóstico de Eventos en Lenguaje Natural

Cuando un email rebota, SendIX actualmente guarda el código de error crudo del proveedor (`550 5.1.1`, `421 4.7.0`, `452 4.2.2`, etc.). Esos códigos son incomprensibles fuera de un contexto técnico específico.

Con este feature, cada evento de rebote en la UI de `/dashboard/events` muestra, además del evento crudo, una explicación generada por IA:

> **Rebote duro — `550 5.1.1`**
> La dirección `juan@empresa.com` no existe en el servidor de destino. Esto puede ser un typo en el email, una cuenta eliminada, o un dominio que ya no acepta correos. Este email no se debe reintentar — considera marcarlo como inválido en tu base de datos para no seguir enviándole.

La explicación se genera llamando a un LLM (OpenAI o Claude) con el código de error, el proveedor de origen, y el contexto del envío. Se cachea por tipo de error para no hacer una llamada de LLM por cada evento — el mismo código de error siempre produce la misma explicación base.

**Cambios necesarios:**
- Nueva columna `ai_diagnosis` (text, nullable) en la tabla `email_events`
- Nuevo `diagnosis.service.ts` que recibe un evento, llama al LLM, y devuelve la explicación
- El diagnóstico se genera de forma asíncrona después de persistir el evento — no bloquea la ingesta del webhook
- La UI de `/dashboard/events` muestra el diagnóstico debajo del evento con un ícono diferenciador

### Feature 2 — Detección de Anomalías y Alertas Proactivas

SendIX tiene datos históricos de eventos de cada developer. Si la tasa de rebote de la última hora es el doble del promedio histórico, algo está mal. Si empiezan a llegar quejas de spam de forma inusual, la reputación del dominio está en riesgo. Si un proveedor específico empieza a fallar más de lo normal, hay un problema de infraestructura.

Este feature corre un proceso periódico que analiza las métricas del developer contra sus propios históricos y genera alertas cuando detecta desviaciones significativas.

Ejemplos de alertas que se generan:

> **⚠ Tasa de rebote elevada — última hora**
> Tu tasa de rebote subió a 4.2% en la última hora. Tu promedio de los últimos 7 días es 0.6%. Esto puede indicar que estás enviando a una lista con muchas direcciones inválidas o que hay un problema con la validación de emails en tu app.

> **🚨 Quejas de spam inusuales**
> Recibiste 8 quejas de spam en las últimas 2 horas. Normalmente recibes menos de 1 por día. Si esto continúa, tu dominio puede quedar en blacklists. Revisa los últimos emails enviados para identificar qué está generando las quejas.

> **⚡ Proveedor con errores elevados**
> Resend está devolviendo errores en el 12% de los intentos de las últimas 3 horas. Tu proveedor de fallback (Brevo) está absorbiendo esos envíos, pero considera revisar el estado de Resend.

Las alertas se entregan por:
- Notificación en el dashboard (badge en el ícono de campana)
- Email al developer (usando su propio SendIX, lo cual es un círculo completo)
- Webhook saliente si el developer lo configuró (conecta directamente con el Pilar A)

**Cambios necesarios:**
- Nuevo `anomaly.service.ts` que corre cada N minutos, calcula métricas agregadas, las compara contra históricos, y genera alertas cuando detecta desviaciones
- Nueva tabla `alerts`: `id`, `user_id`, `type`, `severity` (warning | critical), `message_ai`, `context` (JSONB), `seen_at`, `created_at`
- Nueva ruta `GET /api/alerts` para que el dashboard los consuma
- UI: badge de notificaciones en el sidebar, panel lateral de alertas activas
- Configuración en settings: qué tipos de alertas quiere recibir y por qué canal

### Feature 3 — Resumen Semanal de Salud del Email

Cada lunes, SendIX envía al developer un resumen automático de la semana anterior. No es un newsletter — es un informe técnico generado por IA con los números reales de su cuenta:

> **Resumen de la semana — 2 al 8 de junio**
> Enviaste 1,847 emails. Tu tasa de entrega fue 97.3%, por encima de tu promedio histórico (96.1%). Tuviste 14 rebotes duros — 11 de ellos en el dominio `hotmail.com`, lo que sugiere un problema específico con esas direcciones. Tu tasa de apertura bajó 4 puntos respecto a la semana anterior, pero esto coincide con que la mayoría de tus envíos fueron notificaciones de sistema, que históricamente tienen tasas de apertura menores.
> **Acción sugerida:** Limpia las 11 direcciones de hotmail que rebotaron — están afectando tu reputación de dominio en Microsoft.

El resumen se genera con IA tomando las métricas de la semana, comparándolas contra el histórico, y produciendo texto en español. Se envía por email y también está disponible en el dashboard en una sección de reportes.

**Cambios necesarios:**
- Tarea programada semanal (lunes 8am, zona horaria configurable por developer)
- Nuevo `report.service.ts` que agrega métricas de la semana y llama al LLM para generar el resumen
- Nueva tabla `reports`: `id`, `user_id`, `period_start`, `period_end`, `content_ai` (text), `metrics_snapshot` (JSONB), `created_at`
- Nueva ruta `GET /api/reports` para listar reportes históricos
- Nueva vista `/dashboard/reports` con el historial de resúmenes semanales

---

## Resumen de Cambios por Área

### Backend
| Componente | Acción |
|---|---|
| Nueva tabla `outbound_webhooks` | Suscripciones de webhooks salientes del developer |
| Nueva tabla `alerts` | Alertas generadas por el sistema de anomalías |
| Nueva tabla `reports` | Reportes semanales generados por IA |
| Nueva columna `ai_diagnosis` en `email_events` | Diagnóstico en lenguaje natural por evento |
| Nuevo `diagnosis.service.ts` | Genera diagnósticos de eventos usando LLM |
| Nuevo `anomaly.service.ts` | Detecta desviaciones y genera alertas |
| Nuevo `report.service.ts` | Genera resúmenes semanales con IA |
| `webhook.service.ts` se extiende | Dispara webhooks salientes después de procesar eventos |
| Nueva ruta `POST /api/webhooks/outbound` | Configura webhooks salientes |
| Nueva ruta `GET /api/alerts` | Lista alertas activas |
| Nueva ruta `GET /api/reports` | Lista reportes históricos |

### Frontend
| Elemento | Acción |
|---|---|
| `/dashboard/settings` — sección Webhooks Salientes | Nueva: configura URLs de destino para eventos |
| `/dashboard/settings` — sección Integraciones | Nueva: links y guía de instalación de nodos en n8n/Make/Zapier |
| `/dashboard/events` | Se extiende: muestra diagnóstico de IA debajo de cada evento de rebote |
| Panel de alertas (sidebar) | Nuevo: badge de notificaciones + panel lateral de alertas activas |
| Nueva `/dashboard/reports` | Historial de resúmenes semanales generados por IA |

### Variables de Entorno Nuevas
| Variable | Para qué |
|---|---|
| `OPENAI_API_KEY` o `ANTHROPIC_API_KEY` | LLM para diagnósticos y reportes |
| `AI_PROVIDER` | Cuál LLM usar (`openai` o `anthropic`) |

### Paquetes Externos Nuevos
| Paquete | Para qué |
|---|---|
| `n8n-nodes-sendix` (npm, nuevo repo) | Nodo community para n8n |
| SDK de LLM elegido | Llamadas a la API de IA desde el backend |

---

## Orden de Implementación Sugerido

**Primero — Webhooks salientes y nodo de n8n**
Son la base del Pilar A y tienen el impacto de distribución más alto. Publicar el nodo en el marketplace de n8n pone a SendIX delante de developers que no lo conocen. No depende de IA — se puede hacer apenas esté lista la Fase 1.

**Segundo — Diagnóstico de eventos con IA**
Es el feature de IA de menor complejidad y mayor impacto inmediato. Cualquier developer que vea un rebote en el dashboard va a notar la diferencia entre un código crudo y una explicación en español con una acción sugerida.

**Tercero — Sistema de anomalías y alertas**
Más complejo porque requiere históricos suficientes para que las comparaciones sean significativas. Necesita que la base de usuarios haya estado generando eventos durante algunas semanas antes de que las alertas sean confiables.

**Cuarto — Resúmenes semanales**
El último porque también depende de histórico y porque es el feature con menor urgencia — es valor de retención, no de adquisición.

---

*Documento de Fase 2 — SendIX, junio 2026. Prerequisito: `REDISENO_SENDIX.md` implementado y en producción.*
