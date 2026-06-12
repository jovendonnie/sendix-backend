# Onboarding System — Auditoría y Guía de Implementación General

> Auditado sobre: **Sendix Frontend** (React + Vite + TypeScript + Clerk)  
> Stack actual: **React + Vite + TS + Clerk** (frontend) · **C# ASP.NET Core + EF Core + NeonDB** (backend objetivo)  
> Fecha actualizada: 2026-06-11

---

## Tabla de Contenidos

1. [Auditoría del sistema actual](#1-auditoría-del-sistema-actual)
2. [Arquitectura general del patrón Onboarding](#2-arquitectura-general-del-patrón-onboarding)
3. [Backend — C# + EF Core + NeonDB](#3-backend--c-ef-core-neondb)
4. [Frontend — React + Vite + TypeScript](#4-frontend--react--vite--typescript)
5. [Flujo de datos completo](#5-flujo-de-datos-completo)
6. [Checklist de calidad UX/UI](#6-checklist-de-calidad-uxui)

---

## 1. Auditoría del sistema actual

> El onboarding vive en `frontend/src/app/dashboard/page.tsx` como un card inline dentro del dashboard principal. No es una página separada ni un wizard multi-step.

### 1.1 ¿Qué hace bien?

| Aspecto | Descripción |
|---------|-------------|
| **Diseño visual limpio** | Card con `bg-primary/5` + `border-primary/20` da identidad sin sobrecargar. |
| **Progress bar animado** | `transition-all duration-700` con porcentaje numérico — feedback claro. |
| **Completions desde datos reales** | Cada paso se completa con datos del backend (`providers.length`, `apiKeys.length`, `hasVerifiedDomain`). |
| **Auto-dismiss al completar** | `useEffect` que observa `allCompleted` — no requiere acción del usuario. |
| **Responsive** | Grid `sm:grid-cols-2` — funciona en móvil y desktop. |
| **Carga paralela de datos** | `Promise.allSettled` para los 4 endpoints del dashboard. |
| **Timeout de red** | `AbortController` con 8s de timeout para evitar cuelgues. |

---

### 1.2 Steps actuales del onboarding

Los pasos correctos — derivados del código real en `page.tsx:97-102` — son:

| ID | Label | Condición de completitud | Ruta |
|----|-------|--------------------------|------|
| `account` | Create your account | Siempre `true` | — |
| `provider` | Connect your first provider | `providers.length > 0` | `/dashboard/providers` |
| `api_key` | Create your first API Key | `apiKeys.length > 0` | `/dashboard/api-keys` |
| `domain` | Verify a domain | `hasVerifiedDomain` (algún dominio con `verified: true`) | `/dashboard/domains` |

> **No existe** un paso "Send your first email" ni "Invite a team member" en la implementación actual. El paso crítico de SendIX — y que el audit anterior no contemplaba — es **conectar un provider** (Resend, Brevo, AWS SES, Mailgun, Postmark). Este paso refleja la identidad del producto como orquestador de proveedores, no como cartero directo.

---

### 1.3 Problemas encontrados

#### 🔴 Crítico

**P1 — Estado de dismiss no persiste**
```typescript
// ❌ Actual: solo en memoria (page.tsx:92)
const [onboardingDismissed, setOnboardingDismissed] = useState(false);
// Se pierde al recargar la página — el onboarding reaparece siempre

// ✅ Fix mínimo: localStorage
const [onboardingDismissed, setOnboardingDismissed] = useState(
  () => localStorage.getItem("onboarding_dismissed") === "true"
);
// Al hacer dismiss:
localStorage.setItem("onboarding_dismissed", "true");
setOnboardingDismissed(true);

// ✅ Fix ideal: persistir en el backend (user_onboarding.dismissed)
// PATCH /api/onboarding/dismiss → DB: user_onboarding.dismissed = true
```
**Impacto:** El usuario que descarta el onboarding lo vuelve a ver en cada recarga.

---

**P2 — Steps clickeables son `<div>` con onClick, no `<button>`**
```tsx
// ❌ Actual (page.tsx:298)
<div
  onClick={() => step.href && !step.completed && navigate(step.href)}
  className="..."
>

// ✅ Correcto — accesible con teclado
<button
  onClick={() => step.href && !step.completed && navigate(step.href)}
  disabled={step.completed || !step.href}
  aria-label={`${step.label}: ${step.completed ? "completado" : "pendiente"}`}
  className="..."
>
```
**Impacto:** No funciona con Tab + Enter, invisible para screen readers, sin foco visible. Viola WCAG 2.1 AA.

---

#### 🟡 Importante

**P3 — Sin skeleton durante carga inicial**
```typescript
// ❌ Actual (page.tsx:162-168): spinner global que oculta todo el dashboard
if (loading) return (
  <div className="flex items-center justify-center h-[400px]">
    <div className="animate-spin ..." />
  </div>
);
```
**Impacto:** Los steps se muestran como "incompletos" durante el fetch inicial, creando un flash visual. Considerar skeleton del card de onboarding mientras se cargan los datos.

---

**P4 — Progress bar sin `role="progressbar"`**
```tsx
// ❌ Sin atributos ARIA (page.tsx:283-285)
<div className="w-28 h-1.5 rounded-full bg-border overflow-hidden">
  <div className="h-full rounded-full bg-primary ..." />
</div>

// ✅ Correcto
<div
  role="progressbar"
  aria-valuenow={completedCount}
  aria-valuemin={0}
  aria-valuemax={steps.length}
  aria-label="Progreso de configuración"
  className="w-28 h-1.5 rounded-full bg-border overflow-hidden"
>
  <div className="h-full rounded-full bg-primary ..." />
</div>
```

---

**P5 — Botón "Dismiss" con target de toque insuficiente**
```tsx
// ❌ Solo px-2 py-1 ≈ 28px de alto (page.tsx:288)
<button className="text-xs text-muted hover:text-text px-2 py-1 rounded-lg ...">
  Dismiss
</button>

// ✅ Mínimo 44×44px (Apple HIG / WCAG)
<button className="text-xs text-muted hover:text-text px-3 py-2.5 min-h-[44px] rounded-lg ...">
  Dismiss
</button>
```

---

**P6 — Sin feedback de transición al completar un paso**
Cuando un paso pasa de pendiente a completado solo cambia opacity/color sin animación.
**Fix:** `transition-all duration-500` + micro-scale en el checkmark al completarse.

---

#### 🟢 Mejoras opcionales

**P7 — Sin `aria-live` para screen readers**
Cuando se completa un paso, un screen reader no recibe notificación.
```tsx
<p aria-live="polite" aria-atomic="true" className="text-xs text-muted">
  {completedCount} of {steps.length} completed
</p>
```

**P8 — Mensaje de motivación en el último paso**
Cuando `completedCount === steps.length - 1`, mostrar "¡Un paso más!" para incentivar.

**P9 — Sin Deep Link al card de onboarding**
Si el usuario navega y vuelve, no hay forma de anclar al onboarding. Considerar `?setup=true` en la URL.

---

### 1.4 Tabla de severidad

| ID | Severidad | Categoría | Esfuerzo de Fix |
|----|-----------|-----------|-----------------|
| P1 | 🔴 Crítico | Persistencia | Bajo (localStorage) / Medio (backend) |
| P2 | 🔴 Crítico | Accesibilidad | Bajo |
| P3 | 🟡 Importante | UX / Loading | Medio |
| P4 | 🟡 Importante | Accesibilidad | Bajo |
| P5 | 🟡 Importante | Touch UX | Bajo |
| P6 | 🟡 Importante | Animación | Bajo |
| P7 | 🟢 Opcional | Accesibilidad | Bajo |
| P8 | 🟢 Opcional | UX copywriting | Muy bajo |
| P9 | 🟢 Opcional | Navegación | Medio |

---

## 2. Arquitectura general del patrón Onboarding

### 2.1 Concepto

El patrón **Onboarding Checklist** es un card fijo en el dashboard principal que:

1. Muestra una lista de pasos de configuración esenciales para el producto.
2. Cada paso se resuelve con una **condición derivada de datos reales** del backend.
3. Persiste el estado de "descartado" en el backend o en localStorage.
4. Desaparece automáticamente cuando todos los pasos están completos.

### 2.2 Reglas del dominio

```
OnboardingCard:
  - Solo se muestra si: NOT dismissed AND NOT allCompleted
  - Un paso está "completed" cuando: la condición de negocio es verdadera
  - Los pasos son deterministas: el mismo usuario siempre ve el mismo estado
  - "Dismiss" es una acción explícita del usuario — debe persistirse
  - Los pasos condicionales (ej: solo Pro) se calculan con el plan del usuario
```

### 2.3 Tipos de steps soportados

| Tipo | Condición de completitud |
|------|--------------------------|
| `always_true` | El usuario ya tiene cuenta. Siempre true. |
| `resource_exists` | Al menos un recurso existe (provider, API key, dominio) |
| `resource_verified` | Un recurso específico tiene estado verificado (dominio con `verified: true`) |
| `action_performed` | El usuario realizó una acción (envió un email) |
| `members_count` | La organización tiene más de N miembros |
| `plan_based` | Solo visible para ciertos planes (conditionally rendered) |

---

## 3. Backend — C# + EF Core + NeonDB

### 3.1 Modelo de base de datos

```sql
-- NeonDB (PostgreSQL) — Migrations via EF Core

-- Tabla principal de configuración de onboarding por usuario
CREATE TABLE user_onboarding (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dismissed   BOOLEAN NOT NULL DEFAULT FALSE,
    dismissed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
);

CREATE INDEX idx_user_onboarding_user_id ON user_onboarding(user_id);
```

> **Nota:** Los steps individuales NO se guardan como filas. El estado de cada step se calcula en tiempo real desde los datos reales (providers, API keys, dominios verificados). Solo se persiste el flag `dismissed`.

---

### 3.2 Entity Framework Core — Entidades

```csharp
// Models/UserOnboarding.cs
public class UserOnboarding
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public bool Dismissed { get; set; } = false;
    public DateTime? DismissedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public User User { get; set; } = null!;
}
```

```csharp
// Data/ApplicationDbContext.cs
public class ApplicationDbContext : DbContext
{
    public DbSet<UserOnboarding> UserOnboardings { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<UserOnboarding>(entity =>
        {
            entity.HasIndex(e => e.UserId).IsUnique();
            entity.Property(e => e.CreatedAt).HasDefaultValueSql("NOW()");
            entity.Property(e => e.UpdatedAt).HasDefaultValueSql("NOW()");
        });
    }
}
```

---

### 3.3 DTOs y respuestas

```csharp
// DTOs/OnboardingDto.cs

public record OnboardingStepDto(
    string Id,
    string Label,
    string Description,
    bool Completed,
    string? Href
);

public record OnboardingStatusDto(
    bool Dismissed,
    int CompletedCount,
    int TotalSteps,
    IReadOnlyList<OnboardingStepDto> Steps
);

public record DismissOnboardingRequest(bool Dismissed);
```

---

### 3.4 Servicio de onboarding

```csharp
// Services/OnboardingService.cs
public interface IOnboardingService
{
    Task<OnboardingStatusDto> GetStatusAsync(Guid userId);
    Task DismissAsync(Guid userId);
}

public class OnboardingService : IOnboardingService
{
    private readonly ApplicationDbContext _db;

    public OnboardingService(ApplicationDbContext db)
    {
        _db = db;
    }

    public async Task<OnboardingStatusDto> GetStatusAsync(Guid userId)
    {
        var (onboarding, providerCount, apiKeyCount, hasVerifiedDomain, memberCount, userPlan) =
            await LoadUserDataAsync(userId);

        var steps = BuildSteps(providerCount, apiKeyCount, hasVerifiedDomain, memberCount, userPlan);

        return new OnboardingStatusDto(
            Dismissed: onboarding?.Dismissed ?? false,
            CompletedCount: steps.Count(s => s.Completed),
            TotalSteps: steps.Count,
            Steps: steps
        );
    }

    private async Task<(UserOnboarding?, int, int, bool, int, string)> LoadUserDataAsync(Guid userId)
    {
        var onboardingTask     = _db.UserOnboardings.FirstOrDefaultAsync(o => o.UserId == userId);
        var providerCountTask  = _db.Providers.CountAsync(p => p.UserId == userId);
        var apiKeyCountTask    = _db.ApiKeys.CountAsync(k => k.UserId == userId && !k.Revoked);
        var verifiedDomainTask = _db.Domains.AnyAsync(d => d.UserId == userId && d.Verified);
        var memberCountTask    = _db.OrganizationMembers.CountAsync(m => m.OrganizationId ==
                                    _db.Organizations.Where(o => o.OwnerId == userId)
                                                     .Select(o => o.Id)
                                                     .FirstOrDefault());
        var userPlanTask       = _db.UserBillings
                                    .Where(b => b.UserId == userId)
                                    .Select(b => b.Plan)
                                    .FirstOrDefaultAsync();

        await Task.WhenAll(onboardingTask, providerCountTask, apiKeyCountTask,
                           verifiedDomainTask, memberCountTask, userPlanTask);

        return (
            await onboardingTask,
            await providerCountTask,
            await apiKeyCountTask,
            await verifiedDomainTask,
            await memberCountTask,
            await userPlanTask ?? "free"
        );
    }

    private List<OnboardingStepDto> BuildSteps(
        int providerCount, int apiKeyCount, bool hasVerifiedDomain,
        int memberCount, string plan)
    {
        var steps = new List<OnboardingStepDto>
        {
            new("account",  "Create your account",          "You're in!",                                       true,                    null),
            new("provider", "Connect your first provider",  "Add Resend, Brevo, SES or another provider",       providerCount > 0,       "/dashboard/providers"),
            new("api_key",  "Create your first API Key",    "Generate a key to start sending emails via API",   apiKeyCount > 0,         "/dashboard/api-keys"),
            new("domain",   "Verify a domain",              "Send emails from your own domain",                 hasVerifiedDomain,       "/dashboard/domains"),
        };

        // Step condicional por plan
        if (plan is "pro" or "agency")
        {
            steps.Add(new("invite_member", "Invite a team member", "Collaborate with your team", memberCount > 1, "/dashboard/settings/organization"));
        }

        return steps;
    }

    public async Task DismissAsync(Guid userId)
    {
        var onboarding = await _db.UserOnboardings.FirstOrDefaultAsync(o => o.UserId == userId);

        if (onboarding is null)
        {
            _db.UserOnboardings.Add(new UserOnboarding
            {
                UserId      = userId,
                Dismissed   = true,
                DismissedAt = DateTime.UtcNow
            });
        }
        else
        {
            onboarding.Dismissed   = true;
            onboarding.DismissedAt = DateTime.UtcNow;
            onboarding.UpdatedAt   = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync();
    }
}
```

---

### 3.5 Controller

```csharp
// Controllers/OnboardingController.cs
[ApiController]
[Route("api/onboarding")]
[Authorize]
public class OnboardingController : ControllerBase
{
    private readonly IOnboardingService _onboardingService;

    public OnboardingController(IOnboardingService onboardingService)
    {
        _onboardingService = onboardingService;
    }

    // GET /api/onboarding/status
    [HttpGet("status")]
    public async Task<ActionResult<OnboardingStatusDto>> GetStatus()
    {
        var userId = GetCurrentUserId();
        var status = await _onboardingService.GetStatusAsync(userId);
        return Ok(status);
    }

    // PATCH /api/onboarding/dismiss
    [HttpPatch("dismiss")]
    public async Task<IActionResult> Dismiss()
    {
        var userId = GetCurrentUserId();
        await _onboardingService.DismissAsync(userId);
        return NoContent();
    }

    private Guid GetCurrentUserId()
    {
        var sub = User.FindFirstValue(ClaimTypes.NameIdentifier)
                  ?? throw new UnauthorizedAccessException();
        return Guid.Parse(sub);
    }
}
```

---

### 3.6 Registro de servicios (Program.cs)

```csharp
builder.Services.AddScoped<IOnboardingService, OnboardingService>();
```

---

### 3.7 NeonDB — Consideraciones de conexión

```csharp
// appsettings.json
{
  "ConnectionStrings": {
    "DefaultConnection": "Host=<neon-host>;Database=<db>;Username=<user>;Password=<pass>;SSL Mode=Require;Trust Server Certificate=true;Pooling=true"
  }
}

// Program.cs — Configurar EF Core con Npgsql para NeonDB
builder.Services.AddDbContext<ApplicationDbContext>(options =>
    options.UseNpgsql(
        builder.Configuration.GetConnectionString("DefaultConnection"),
        npgsql => npgsql.EnableRetryOnFailure(3)  // NeonDB puede tener cold starts
    )
);
```

> **Importante con NeonDB:** Habilitar connection pooling vía PgBouncer (parámetro `Pooling=true` en la URL). Evitar mantener conexiones abiertas largas.

---

## 4. Frontend — React + Vite + TypeScript

> El frontend usa **React 18 + React Router v7 + Tailwind CSS 4 + Clerk** para auth. No usa Angular.  
> El onboarding vive en `frontend/src/app/dashboard/page.tsx`.

### 4.1 Tipos TypeScript

```typescript
// types/onboarding.ts

export interface OnboardingStep {
  id: string;
  label: string;
  description: string;
  completed: boolean;
  href: string | null;
}

export interface OnboardingStatus {
  dismissed: boolean;
  completedCount: number;
  totalSteps: number;
  steps: OnboardingStep[];
}
```

---

### 4.2 Hook personalizado

```typescript
// hooks/useOnboarding.ts
import { useState, useEffect } from "react";
import { useAuth } from "./useAuth";
import type { OnboardingStatus } from "../types/onboarding";

const STORAGE_KEY = "onboarding_dismissed";

export function useOnboarding() {
  const { getToken } = useAuth();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(STORAGE_KEY) === "true"
  );

  useEffect(() => {
    fetchStatus();
  }, []);

  async function fetchStatus() {
    setLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/onboarding/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data: OnboardingStatus = await res.json();
      setStatus(data);
      if (data.dismissed) persistDismiss();
    } finally {
      setLoading(false);
    }
  }

  async function dismiss() {
    persistDismiss();
    const token = await getToken();
    await fetch(`${import.meta.env.VITE_API_URL}/api/onboarding/dismiss`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  function persistDismiss() {
    localStorage.setItem(STORAGE_KEY, "true");
    setDismissed(true);
  }

  const allCompleted = status ? status.completedCount === status.totalSteps : false;
  const showCard = !dismissed && !allCompleted && status !== null;

  return { status, loading, showCard, allCompleted, dismiss };
}
```

---

### 4.3 Componente React (accesible)

```tsx
// components/OnboardingCard.tsx
import { useNavigate } from "react-router-dom";
import { Check, ChevronRight, Zap } from "lucide-react";
import { useOnboarding } from "../hooks/useOnboarding";
import type { OnboardingStep } from "../types/onboarding";

export function OnboardingCard() {
  const navigate = useNavigate();
  const { status, showCard, dismiss } = useOnboarding();

  if (!showCard || !status) return null;

  const { steps, completedCount, totalSteps } = status;
  const progressPercent = Math.round((completedCount / totalSteps) * 100);

  function handleStepClick(step: OnboardingStep) {
    if (!step.completed && step.href) navigate(step.href);
  }

  return (
    <div
      className="rounded-2xl border border-primary/20 bg-primary/5 p-5"
      role="region"
      aria-label="Getting started checklist"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-primary/15 flex items-center justify-center" aria-hidden="true">
            <Zap className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-text">Getting started</h2>
            <p
              className="text-xs text-muted"
              aria-live="polite"
              aria-atomic="true"
            >
              {completedCount} of {totalSteps} completed
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Progress bar — accesible */}
          <div
            role="progressbar"
            aria-valuenow={completedCount}
            aria-valuemin={0}
            aria-valuemax={totalSteps}
            aria-label="Setup progress"
            className="flex items-center gap-2"
          >
            <div className="w-28 h-1.5 rounded-full bg-border overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-700"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="text-xs font-medium text-primary">{progressPercent}%</span>
          </div>

          {/* Dismiss — mínimo 44px touch target */}
          <button
            onClick={dismiss}
            className="text-xs text-muted hover:text-text transition-colors px-3 py-2.5 min-h-[44px] rounded-lg hover:bg-card"
            aria-label="Dismiss getting started checklist"
            type="button"
          >
            Dismiss
          </button>
        </div>
      </div>

      {/* Steps grid */}
      <div className="grid gap-2 sm:grid-cols-2">
        {steps.map(step => (
          <button
            key={step.id}
            onClick={() => handleStepClick(step)}
            disabled={step.completed || !step.href}
            aria-label={`${step.label}: ${step.completed ? "completado" : "pendiente"}`}
            type="button"
            className={`flex items-center gap-3 p-3 rounded-xl text-left transition-all w-full border ${
              step.completed
                ? "opacity-50 cursor-default border-transparent"
                : step.href
                  ? "hover:bg-card cursor-pointer border-transparent hover:border-border"
                  : "cursor-default border-transparent"
            }`}
          >
            {/* Indicator */}
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-all duration-300 ${
                step.completed ? "bg-primary scale-105" : "border-2 border-border bg-card"
              }`}
              aria-hidden="true"
            >
              {step.completed && <Check className="w-3 h-3 text-white" />}
            </div>

            {/* Text */}
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${step.completed ? "line-through text-muted" : "text-text"}`}>
                {step.label}
              </p>
              {!step.completed && (
                <p className="text-xs text-muted truncate">{step.description}</p>
              )}
            </div>

            {/* Chevron affordance */}
            {!step.completed && step.href && (
              <ChevronRight className="w-4 h-4 text-muted shrink-0" aria-hidden="true" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
```

---

### 4.4 Integración en el Dashboard

```tsx
// app/dashboard/page.tsx — añadir componente donde hoy está el card inline
import { OnboardingCard } from "../../components/OnboardingCard";

export default function DashboardPage() {
  // ... resto del estado del dashboard ...

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <DashboardHeader user={user} onManageProviders={() => navigate("/dashboard/providers")} />

      {/* Alerta de provider inactivo */}
      {metrics.providerError && <ProviderErrorAlert onFix={() => navigate("/dashboard/providers")} />}

      {/* Onboarding — se auto-oculta */}
      <OnboardingCard />

      {/* Métricas */}
      <MetricCards metrics={metrics} />

      {/* Acciones rápidas */}
      <QuickActions />

      {/* Actividad reciente */}
      <RecentActivity messages={recentMessages} />
    </div>
  );
}
```

---

### 4.5 Skeleton de carga (P3 fix)

```tsx
// components/OnboardingCardSkeleton.tsx
export function OnboardingCardSkeleton() {
  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5 animate-pulse">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-8 h-8 rounded-xl bg-primary/20" />
        <div className="space-y-1.5">
          <div className="h-3.5 w-28 bg-primary/15 rounded" />
          <div className="h-3 w-20 bg-muted/20 rounded" />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-3 rounded-xl">
            <div className="w-6 h-6 rounded-full bg-border shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 w-3/4 bg-border rounded" />
              <div className="h-3 w-1/2 bg-border/60 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 5. Flujo de datos completo

```
USUARIO LLEGA AL DASHBOARD
        │
        ▼
GET /api/onboarding/status   (o via Promise.allSettled del dashboard)
        │
        ▼
 ┌──────────────────────────────────────────────────┐
 │  OnboardingService.GetStatusAsync(userId)         │
 │                                                    │
 │  Parallel queries a NeonDB (EF Core):             │
 │  ├── UserOnboardings WHERE user_id = {userId}     │
 │  ├── Providers COUNT WHERE user_id = {userId}     │
 │  ├── ApiKeys COUNT WHERE user_id = {userId}       │
 │  ├── Domains ANY WHERE verified = true            │
 │  ├── OrganizationMembers COUNT (Pro/Agency)       │
 │  └── UserBillings.Plan                            │
 └──────────────────────────────────────────────────┘
        │
        ▼
 Devuelve: { dismissed, completedCount, totalSteps, steps[] }
        │
        ▼
 React: status actualizado → showCard = !dismissed && !allCompleted
        │
        ├── true  → renderiza <OnboardingCard />
        └── false → null (sin espacio en layout)

USUARIO HACE CLIC EN UN STEP
        │
        ▼
 navigate(step.href)
 (ej: /dashboard/providers → conecta Resend → vuelve al dashboard)
        │
        ▼
 useEffect → fetchStatus() → step aparece como completado

USUARIO HACE CLIC EN "DISMISS"
        │
        ▼
 localStorage.setItem("onboarding_dismissed", "true")   ← inmediato
 PATCH /api/onboarding/dismiss                          ← async, sin bloquear UI
        │
        ▼
 dismissed = true → showCard = false → card desaparece sin reload

TODOS LOS STEPS COMPLETADOS
        │
        ▼
 allCompleted = true → useEffect dispara dismiss() automáticamente
 → card se oculta sin acción del usuario
```

---

## 6. Checklist de calidad UX/UI

Antes de considerar el onboarding como completo, verificar:

### Steps correctos
- [ ] El paso `provider` ("Connect your first provider") existe y es el **segundo paso** (tras account)
- [ ] El paso `api_key` se completa cuando hay al menos una key no revocada
- [ ] El paso `domain` se completa cuando `domains.some(d => d.verified)` es true
- [ ] No hay paso "Send your first email" — esa ruta (`/dashboard/send`) no está implementada
- [ ] El paso `invite_member` solo aparece para planes Pro y Agency

### Funcionalidad
- [ ] El estado `dismissed` persiste en base de datos (PATCH /api/onboarding/dismiss)
- [ ] Fallback a localStorage mientras el backend no esté listo
- [ ] Todos los steps calculan su completitud desde datos reales del backend
- [ ] Al completar todos los steps, la card se oculta automáticamente
- [ ] El dismiss funciona sin recargar la página
- [ ] Refreshing la página mantiene el estado correcto

### Accesibilidad (WCAG 2.1 AA)
- [ ] Los steps clickeables son elementos `<button>` (no `<div>` con onClick)
- [ ] La progress bar tiene `role="progressbar"` con `aria-valuenow/min/max`
- [ ] El botón Dismiss tiene `aria-label` descriptivo
- [ ] El contador "X of Y" tiene `aria-live="polite"` para screen readers
- [ ] Todos los elementos interactivos tienen `focus-visible` con outline visible
- [ ] La navegación por teclado (Tab + Enter) funciona en todos los steps

### Touch & Interacción
- [ ] El botón Dismiss tiene mínimo `44×44px` de área de toque (`min-h-[44px]`)
- [ ] Los steps tienen mínimo `44px` de alto como touch target
- [ ] Existe feedback visual en hover y focus en items clickeables

### Rendimiento
- [ ] Las queries al backend se lanzan en paralelo (`Task.WhenAll` en C# / `Promise.allSettled` en React)
- [ ] Existe un skeleton de carga mientras se obtienen datos (no solo spinner global)
- [ ] La progress bar tiene `transition-all duration-700` suave
- [ ] NeonDB connection pooling habilitado para evitar latencia por cold starts

### Diseño
- [ ] La card desaparece limpiamente (sin salto de layout) cuando se descarta
- [ ] Los steps completados muestran estado visual diferenciado (check + opacidad + line-through)
- [ ] Los steps pendientes con href muestran chevron como affordance de click
- [ ] La card no bloquea ni interfiere con el contenido del dashboard

---

*Documento actualizado el 2026-06-11 — refleja la implementación real de Sendix Frontend (React + Vite + TS + Clerk)*
