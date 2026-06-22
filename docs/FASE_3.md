# SendIX — Fase 3
### Infraestructura White-Label para Agencias

> **Prerequisito:** Fase 1 y Fase 2 implementadas, estables y con base de usuarios activa.
> Esta fase no modifica la arquitectura base — introduce un modelo de multi-tenancy jerárquico encima de ella.

---

## El Problema Que Resuelve

Las agencias de desarrollo manejan 10, 20, 50 clientes simultáneamente. Cada cliente tiene su propia aplicación, su propio dominio de envío, su propio volumen de correos, y sus propios proveedores o presupuesto para proveedores.

Ninguna plataforma de email transaccional está diseñada para ese escenario. Resend, Postmark, Brevo y SendGrid asumen que eres una empresa enviando tus propios correos. Si eres una agencia, tienes dos opciones hoy: crear una cuenta separada por cliente (sin visibilidad consolidada, sin facturación unificada, sin gestión centralizada) o meter a todos los clientes bajo una misma cuenta (sin aislamiento de datos, sin que el cliente pueda ver sus propios logs, sin posibilidad de revender).

SendIX Fase 3 resuelve exactamente ese problema.

---

## Qué es la Infraestructura White-Label

SendIX se convierte en la plataforma que la agencia le vende a sus clientes como si fuera suya.

La agencia tiene una cuenta de agencia en SendIX. Desde ahí crea sub-cuentas para cada uno de sus clientes. Cada cliente tiene su propio dashboard, sus propios proveedores conectados, sus propios eventos y analytics, sus propias API keys — completamente aislado de los demás clientes. La agencia ve todo desde arriba: todos los clientes, sus métricas consolidadas, su facturación unificada.

El cliente nunca sabe que está usando SendIX. Ve el logo de la agencia, el dominio de la agencia, la marca de la agencia.

---

## Cómo Funciona

### Vista de la agencia

La agencia tiene un panel de administración que no existe en los planes actuales de SendIX. Desde ahí puede:

- Crear y gestionar sub-cuentas de clientes
- Ver el estado de todos los clientes en una sola pantalla: cuántos emails enviaron esta semana, tasa de entrega, si hay alguna alerta activa
- Asignar proveedores por cliente — puede conectar los proveedores del cliente, o conectar sus propios proveedores y compartirlos entre clientes
- Controlar qué features ve cada cliente en su dashboard
- Ver la facturación consolidada de todos los clientes en un solo lugar

### Vista del cliente

El cliente entra a `email.agencia.com` (dominio personalizado de la agencia), ve el logo de la agencia, y tiene acceso a su propio dashboard de SendIX con sus datos únicamente. No ve a los otros clientes de la agencia. No sabe que la plataforma es SendIX.

El cliente puede ver sus eventos, sus analytics, sus proveedores conectados, y sus API keys — exactamente lo mismo que un usuario normal de SendIX, pero bajo la marca de la agencia y con los permisos que la agencia le haya asignado. Si la agencia no quiere que el cliente conecte sus propios proveedores (porque la agencia los gestiona), puede desactivar esa sección para ese cliente.

### Dominio personalizado

La agencia configura un subdominio propio (`email.agencia.com`) que apunta al dashboard de SendIX con su branding. Esto requiere configuración de DNS desde el panel de agencia y un certificado SSL gestionado por SendIX. El cliente accede por ese dominio y nunca ve `sendix.dev` en ningún lado.

---

## Cambios en la Arquitectura

### Modelo de datos — nuevo nivel jerárquico

La jerarquía actual de SendIX es plana: cada usuario tiene sus propios recursos. La Fase 3 introduce un nivel intermedio:

```
Agencia
  └── Cliente A
        └── Proveedores, Eventos, API Keys, Alertas
  └── Cliente B
        └── Proveedores, Eventos, API Keys, Alertas
  └── Cliente C
        └── Proveedores, Eventos, API Keys, Alertas
```

**Nueva tabla `agencies`:** `id`, `owner_user_id`, `name`, `custom_domain`, `logo_url`, `primary_color`, `created_at`.

**Nueva tabla `agency_clients`:** `id`, `agency_id`, `client_user_id`, `display_name`, `permissions` (JSONB — qué secciones puede ver el cliente), `created_at`.

Todo el resto de las tablas (`providers`, `email_events`, `messages`, `api_keys`) ya están aisladas por `user_id`. El cliente de la agencia es simplemente un `user_id` más — el aislamiento ya existe. Lo que se agrega es la capa de administración encima.

### Backend — rutas nuevas

```
POST   /api/agency                        — crear cuenta de agencia
GET    /api/agency/clients                — listar clientes
POST   /api/agency/clients                — crear sub-cuenta de cliente
PUT    /api/agency/clients/:id            — actualizar permisos o configuración
DELETE /api/agency/clients/:id            — eliminar cliente
GET    /api/agency/clients/:id/overview   — métricas de un cliente específico
GET    /api/agency/overview               — métricas consolidadas de todos los clientes
POST   /api/agency/domain                 — configurar dominio personalizado
```

### Frontend — nuevas vistas

**`/agency/dashboard`** — Panel central de la agencia. Vista de todos los clientes con su estado en tarjetas: nombre del cliente, emails enviados esta semana, tasa de entrega, alertas activas si las hay.

**`/agency/clients`** — Gestión de sub-cuentas. Crear, editar, desactivar clientes. Asignar permisos por cliente.

**`/agency/clients/:id`** — Vista de drill-down de un cliente específico. La agencia ve exactamente lo mismo que vería el cliente en su propio dashboard.

**`/agency/billing`** — Facturación consolidada. La agencia ve el consumo total y por cliente, y puede descargar facturas unificadas.

**`/agency/settings`** — Configuración de branding: subir logo, definir color primario, configurar dominio personalizado.

---

## Modelo de Cobro — Por Cliente Gestionado

La Fase 3 introduce un modelo de cobro distinto al de los planes base. No es por eventos almacenados — es por cliente gestionado.

---

### Plan Agencia Starter
**$49 USD / mes**

- Hasta 5 clientes activos
- Branding personalizado (logo y colores)
- Dashboard consolidado de agencia
- Cada cliente incluye el equivalente al plan Developer (100,000 eventos/mes, 30 días retención)
- Soporte en español en 48h

---

### Plan Agencia Pro
**$149 USD / mes**

- Hasta 20 clientes activos
- Branding personalizado + dominio personalizado (`email.agencia.com`)
- Dashboard consolidado con analytics comparativos entre clientes
- Cada cliente incluye el equivalente al plan Pro (1,000,000 eventos/mes, 90 días retención)
- Soporte en español prioritario en 24h

---

### Plan Agencia Enterprise
**Precio a convenir**

- Clientes ilimitados
- Dominio personalizado + certificado SSL gestionado
- SLA de uptime garantizado
- Onboarding asistido para la agencia y sus clientes
- Facturación en moneda local (MXN, BRL, ARS)
- Soporte dedicado

---

### Por qué este modelo cambia todo

Con los planes base de SendIX, el costo escala con los eventos. Con el plan de agencia, el costo escala con los clientes — que es exactamente cómo escala el negocio de la agencia. Cuando la agencia gana un cliente nuevo, sabe exactamente cuánto le cuesta ese cliente en infraestructura. Puede incluirlo en el precio que le cobra al cliente o absorberlo como margen.

Esto permite que la agencia revenda SendIX como parte de sus servicios sin que el costo sea impredecible. Una agencia con 15 clientes paga $149 al mes, le cobra a cada cliente lo que considere justo, y mantiene el margen controlado.

---

## Por Qué Esto es un Mercado sin Competencia Real

Resend está diseñado para una empresa con una sola cuenta. Postmark igual. Brevo tiene funciones de sub-cuentas pero están orientadas a campañas de marketing, no a email transaccional con observabilidad por cliente. SendGrid tiene opciones de sub-usuario pero la experiencia es técnicamente compleja y no está pensada para una agencia que quiere revender con su marca.

El mercado de agencias latinoamericanas que manejan el stack técnico de sus clientes es grande y no tiene una solución dedicada. SendIX en Fase 3 es esa solución.

---

## Orden de Implementación

**Primero — Multi-tenancy jerárquico en el backend**
Las tablas nuevas y las rutas de agencia. Es la base de todo y el cambio más crítico porque introduce una nueva capa en el modelo de datos.

**Segundo — Panel de administración de agencia en el frontend**
El dashboard de agencia con la vista consolidada de clientes.

**Tercero — Branding y dominio personalizado**
La parte técnicamente más compleja: manejo de subdominios, certificados SSL, y renderizado del dashboard con branding dinámico por agencia.

**Cuarto — Facturación del plan agencia**
Integración con el sistema de pagos para el nuevo modelo de cobro por cliente gestionado.

---

*Documento de Fase 3 — SendIX, junio 2026. Prerequisito: `FASE_2.md` implementado y en producción.*
