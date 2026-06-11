# Onboarding System — Auditoría y Guía de Implementación General

> Auditado sobre: **Sendix Frontend** (React + Vite + Tailwind + Clerk)  
> Stack objetivo: **Angular + C# (ASP.NET Core + Entity Framework Core) + NeonDB (PostgreSQL)**  
> Fecha: 2026-06-10

---

## Tabla de Contenidos

1. [Auditoría del sistema actual](#1-auditoría-del-sistema-actual)
2. [Arquitectura general del patrón Onboarding](#2-arquitectura-general-del-patrón-onboarding)
3. [Backend — C# + EF Core + NeonDB](#3-backend--c-ef-core-neondb)
4. [Frontend — Angular](#4-frontend--angular)
5. [Flujo de datos completo](#5-flujo-de-datos-completo)
6. [Checklist de calidad UX/UI](#6-checklist-de-calidad-uxui)

---

## 1. Auditoría del sistema actual

### 1.1 ¿Qué hace bien?

| Aspecto | Descripción |
|---------|-------------|
| **Diseño visual limpio** | Card con `bg-primary/5` + `border-primary/20` da identidad sin sobrecargar. |
| **Progress bar animado** | `transition-all duration-700` con porcentaje numérico — feedback claro. |
| **Completions desde datos reales** | Cada paso se completa con datos del backend, no con flags manuales. |
| **Steps condicionales por plan** | El paso "Invite member" solo aparece en Pro/Agency — UX correcta. |
| **Auto-dismiss al completar** | `useEffect` que observa `allCompleted` — no requiere acción del usuario. |
| **Responsive** | Grid `sm:grid-cols-2` — funciona en móvil y desktop. |
| **Empty states** | Cada sección del dashboard (API Keys, Activity) tiene su estado vacío con CTA. |

---

### 1.2 Problemas encontrados

#### 🔴 Crítico

**P1 — Estado de dismiss no persiste**
```typescript
// ❌ Actual: solo en memoria
const [onboardingDismissed, setOnboardingDismissed] = useState(false);
// Se pierde al recargar la página — el onboarding reaparece siempre
```
**Impacto:** El usuario que descarta el onboarding lo vuelve a ver en cada recarga.  
**Fix:** Persistir en `localStorage` o, mejor, en el backend (`user_settings.onboarding_dismissed`).

---

**P2 — `membersCount` está hardcodeado**
```typescript
// ❌ En fetchData():
setMembersCount(1);
// El paso "Invite member" NUNCA se completa, aunque existan miembros
```
**Impacto:** Un usuario Pro/Agency que ya invitó miembros sigue viendo el paso como pendiente.  
**Fix:** Llamar al endpoint de miembros de la organización y contar los resultados.

---

**P3 — Steps clickeables no son elementos `<button>`**
```tsx
// ❌ Actual: div con onClick
<div onClick={() => step.href && !step.completed && navigate(step.href)} ...>
```
**Impacto:** No funciona con teclado (Tab + Enter), no accesible para screen readers, sin foco visible.  
**Fix (WCAG 2.1 AA):**
```tsx
// ✅ Correcto
<button
  onClick={() => step.href && !step.completed && navigate(step.href)}
  disabled={step.completed || !step.href}
  aria-label={`${step.label}: ${step.completed ? "completado" : "pendiente"}`}
  ...
>
```

---

#### 🟡 Importante

**P4 — Sin skeleton durante carga inicial**
```typescript
// ❌ Actual: spinner global que oculta todo el dashboard
if (loading) return <div className="...spinner..." />;
```
**Impacto:** Los steps se muestran como "incompletos" durante el fetch inicial, creando un flash visual.  
**Fix:** Mostrar skeleton del card de onboarding mientras se cargan los datos.

---

**P5 — Progress bar sin `role="progressbar"`**
```tsx
// ❌ Sin atributos ARIA
<div className="h-full rounded-full bg-primary ...">
// ✅ Correcto
<div
  role="progressbar"
  aria-valuenow={completedCount}
  aria-valuemin={0}
  aria-valuemax={steps.length}
  aria-label="Progreso de configuración"
  className="h-full rounded-full bg-primary ..."
/>
```

---

**P6 — Botón "Dismiss" con target de toque insuficiente**
```tsx
// ❌ Solo px-2 py-1 → aproximadamente 28px de alto
<button className="text-xs text-muted hover:text-text px-2 py-1 ...">
  Dismiss
</button>
// ✅ Mínimo 44×44px (Apple HIG / WCAG)
<button className="text-xs text-muted hover:text-text px-3 py-2 min-h-[44px] ...">
```

---

**P7 — Sin feedback de transición al completar un paso**
Cuando un paso pasa de pendiente a completado, solo cambia opacity sin animación.  
**Fix:** Agregar `transition-all duration-500` y un micro-scale en el checkmark.

---

#### 🟢 Mejoras opcionales

**P8 — Sin `aria-live` para screen readers**  
Cuando se completa un paso, un screen reader no recibe notificación.  
**Fix:** `<div aria-live="polite" aria-atomic="true">` alrededor del contador "X of Y completed".

**P9 — Mensaje de motivación en el último paso**  
Cuando `completedCount === steps.length - 1`, mostrar "¡Un paso más!" para incentivar.

**P10 — Sin Deep Link a la card de onboarding**  
Si el usuario navega y vuelve, no hay forma de anclar al onboarding. Considerar `?setup=true` en la URL.

---

### 1.3 Tabla de severidad

| ID | Severidad | Categoría | Esfuerzo de Fix |
|----|-----------|-----------|-----------------|
| P1 | 🔴 Crítico | Persistencia | Bajo (localStorage) / Medio (backend) |
| P2 | 🔴 Crítico | Datos | Bajo |
| P3 | 🔴 Crítico | Accesibilidad | Bajo |
| P4 | 🟡 Importante | UX / Loading | Medio |
| P5 | 🟡 Importante | Accesibilidad | Bajo |
| P6 | 🟡 Importante | Touch UX | Bajo |
| P7 | 🟡 Importante | Animación | Bajo |
| P8 | 🟢 Opcional | Accesibilidad | Bajo |
| P9 | 🟢 Opcional | UX copywriting | Muy bajo |
| P10 | 🟢 Opcional | Navegación | Medio |

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
| `resource_exists` | Al menos un recurso existe (API key, dominio, etc.) |
| `resource_verified` | Un recurso específico tiene un estado verificado |
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

-- Índice para queries frecuentes
CREATE INDEX idx_user_onboarding_user_id ON user_onboarding(user_id);
```

> **Nota:** Los steps individuales NO se guardan como filas. El estado de cada step se calcula en tiempo real desde los datos reales (API keys, dominios, emails enviados). Solo se persiste el flag `dismissed`.

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

    // Navigation
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

```csharp
// Migrations: agregar en Package Manager Console
// Add-Migration AddUserOnboarding
// Update-Database
```

---

### 3.3 DTO y respuestas

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
        // Cargar todos los datos en paralelo
        var (onboarding, apiKeyCount, emailCount, hasVerifiedDomain, memberCount, userPlan) =
            await LoadUserDataAsync(userId);

        var steps = BuildSteps(apiKeyCount, emailCount, hasVerifiedDomain, memberCount, userPlan);

        return new OnboardingStatusDto(
            Dismissed: onboarding?.Dismissed ?? false,
            CompletedCount: steps.Count(s => s.Completed),
            TotalSteps: steps.Count,
            Steps: steps
        );
    }

    private async Task<(UserOnboarding?, int, int, bool, int, string)> LoadUserDataAsync(Guid userId)
    {
        var onboardingTask    = _db.UserOnboardings.FirstOrDefaultAsync(o => o.UserId == userId);
        var apiKeyCountTask   = _db.ApiKeys.CountAsync(k => k.UserId == userId && !k.Revoked);
        var emailCountTask    = _db.Messages.CountAsync(m => m.UserId == userId);
        var verifiedDomainTask = _db.Domains.AnyAsync(d => d.UserId == userId && d.Verified);
        var memberCountTask   = _db.OrganizationMembers.CountAsync(m => m.OrganizationId ==
                                    _db.Organizations.Where(o => o.OwnerId == userId)
                                                     .Select(o => o.Id)
                                                     .FirstOrDefault());
        var userPlanTask      = _db.UserBillings
                                   .Where(b => b.UserId == userId)
                                   .Select(b => b.Plan)
                                   .FirstOrDefaultAsync();

        await Task.WhenAll(onboardingTask, apiKeyCountTask, emailCountTask,
                           verifiedDomainTask, memberCountTask, userPlanTask);

        return (
            await onboardingTask,
            await apiKeyCountTask,
            await emailCountTask,
            await verifiedDomainTask,
            await memberCountTask,
            await userPlanTask ?? "free"
        );
    }

    private List<OnboardingStepDto> BuildSteps(
        int apiKeyCount, int emailCount, bool hasVerifiedDomain,
        int memberCount, string plan)
    {
        var steps = new List<OnboardingStepDto>
        {
            new("account",       "Create your account",      "You're in!",                                            true,                      null),
            new("api_key",       "Create your first API Key","Generate a key to start sending",                       apiKeyCount > 0,           "/dashboard/api-keys"),
            new("send_email",    "Send your first email",    "Send a test email to verify everything works",          emailCount > 0,            "/dashboard/send"),
            new("verify_domain", "Verify a domain",          "Send emails from your own domain",                     hasVerifiedDomain,         "/dashboard/domains"),
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
        // Adaptar según tu sistema de auth (JWT claims, etc.)
        var sub = User.FindFirstValue(ClaimTypes.NameIdentifier)
                  ?? throw new UnauthorizedAccessException();
        return Guid.Parse(sub);
    }
}
```

---

### 3.6 Registro de servicios (Program.cs)

```csharp
// Program.cs
builder.Services.AddScoped<IOnboardingService, OnboardingService>();
```

---

### 3.7 NeonDB — Consideraciones de conexión

```csharp
// appsettings.json
{
  "ConnectionStrings": {
    "DefaultConnection": "Host=<neon-host>;Database=<db>;Username=<user>;Password=<pass>;SSL Mode=Require;Trust Server Certificate=true"
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

> **Importante con NeonDB:** Habilitar **connection pooling** vía PgBouncer (NeonDB lo ofrece de forma nativa en la URL de conexión con `;Pooling=true`). Evitar mantener conexiones abiertas largas.

---

## 4. Frontend — Angular

### 4.1 Modelo TypeScript (interfaces)

```typescript
// models/onboarding.model.ts

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

### 4.2 Servicio Angular

```typescript
// services/onboarding.service.ts
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { OnboardingStatus } from '../models/onboarding.model';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class OnboardingService {
  private http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/api/onboarding`;

  getStatus(): Observable<OnboardingStatus> {
    return this.http.get<OnboardingStatus>(`${this.base}/status`);
  }

  dismiss(): Observable<void> {
    return this.http.patch<void>(`${this.base}/dismiss`, {});
  }
}
```

---

### 4.3 Componente Standalone (Angular 17+)

```typescript
// components/onboarding-card/onboarding-card.component.ts
import {
  Component, OnInit, ChangeDetectionStrategy, signal, computed, inject
} from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { OnboardingService } from '../../services/onboarding.service';
import { OnboardingStatus, OnboardingStep } from '../../models/onboarding.model';

@Component({
  selector: 'app-onboarding-card',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './onboarding-card.component.html',
  styleUrl: './onboarding-card.component.scss'
})
export class OnboardingCardComponent implements OnInit {
  private onboardingService = inject(OnboardingService);
  private router            = inject(Router);

  // Signals para reactividad eficiente
  status    = signal<OnboardingStatus | null>(null);
  loading   = signal(true);

  // Computed values
  allCompleted = computed(() => {
    const s = this.status();
    return s ? s.completedCount === s.totalSteps : false;
  });

  progressPercent = computed(() => {
    const s = this.status();
    if (!s || s.totalSteps === 0) return 0;
    return Math.round((s.completedCount / s.totalSteps) * 100);
  });

  showCard = computed(() => {
    const s = this.status();
    return s !== null && !s.dismissed && !this.allCompleted();
  });

  ngOnInit(): void {
    this.loadStatus();
  }

  private loadStatus(): void {
    this.loading.set(true);
    this.onboardingService.getStatus().subscribe({
      next: (data) => {
        this.status.set(data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  navigateToStep(step: OnboardingStep): void {
    if (!step.completed && step.href) {
      this.router.navigateByUrl(step.href);
    }
  }

  dismiss(): void {
    this.onboardingService.dismiss().subscribe(() => {
      const current = this.status();
      if (current) {
        this.status.set({ ...current, dismissed: true });
      }
    });
  }

  trackByStepId(_: number, step: OnboardingStep): string {
    return step.id;
  }
}
```

---

### 4.4 Template Angular (accesible)

```html
<!-- onboarding-card.component.html -->
@if (showCard()) {
  <div class="onboarding-card" role="region" aria-label="Getting started checklist">

    <!-- Header -->
    <div class="onboarding-header">
      <div class="onboarding-title-group">
        <div class="onboarding-icon" aria-hidden="true">⚡</div>
        <div>
          <h2 class="onboarding-title">Getting started</h2>
          <p
            class="onboarding-subtitle"
            aria-live="polite"
            aria-atomic="true"
          >
            {{ status()?.completedCount }} of {{ status()?.totalSteps }} completed
          </p>
        </div>
      </div>

      <div class="onboarding-controls">
        <!-- Progress bar -->
        <div
          role="progressbar"
          [attr.aria-valuenow]="status()?.completedCount"
          [attr.aria-valuemin]="0"
          [attr.aria-valuemax]="status()?.totalSteps"
          aria-label="Setup progress"
          class="progress-container"
        >
          <div class="progress-track">
            <div
              class="progress-fill"
              [style.width.%]="progressPercent()"
            ></div>
          </div>
          <span class="progress-text">{{ progressPercent() }}%</span>
        </div>

        <!-- Dismiss button -->
        <button
          class="dismiss-btn"
          (click)="dismiss()"
          aria-label="Dismiss getting started checklist"
          type="button"
        >
          Dismiss
        </button>
      </div>
    </div>

    <!-- Steps grid -->
    <div class="steps-grid">
      @for (step of status()?.steps; track trackByStepId($index, step)) {
        <button
          class="step-item"
          [class.step-completed]="step.completed"
          [class.step-pending]="!step.completed && step.href"
          [disabled]="step.completed || !step.href"
          (click)="navigateToStep(step)"
          [attr.aria-label]="step.label + ': ' + (step.completed ? 'completed' : 'pending')"
          type="button"
        >
          <!-- Check indicator -->
          <div
            class="step-indicator"
            [class.step-indicator--done]="step.completed"
            aria-hidden="true"
          >
            @if (step.completed) {
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 6l3 3 5-5" stroke="white" stroke-width="2"
                      stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            }
          </div>

          <!-- Step text -->
          <div class="step-content">
            <p class="step-label" [class.step-label--done]="step.completed">
              {{ step.label }}
            </p>
            @if (!step.completed) {
              <p class="step-description">{{ step.description }}</p>
            }
          </div>

          <!-- Chevron -->
          @if (!step.completed && step.href) {
            <svg class="step-chevron" width="16" height="16" viewBox="0 0 16 16"
                 fill="none" aria-hidden="true">
              <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          }
        </button>
      }
    </div>

  </div>
}
```

---

### 4.5 Estilos SCSS

```scss
// onboarding-card.component.scss

.onboarding-card {
  border-radius: 1rem;
  border: 1px solid color-mix(in srgb, var(--color-primary) 20%, transparent);
  background: color-mix(in srgb, var(--color-primary) 5%, transparent);
  padding: 1.25rem;
}

.onboarding-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
  gap: 1rem;
  flex-wrap: wrap;
}

.onboarding-title-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.onboarding-icon {
  width: 2rem;
  height: 2rem;
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--color-primary) 15%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
}

.onboarding-title {
  font-size: 0.875rem;
  font-weight: 600;
  margin: 0;
}

.onboarding-subtitle {
  font-size: 0.75rem;
  color: var(--color-muted);
  margin: 0;
}

.onboarding-controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

// Progress bar — accesible con role="progressbar"
.progress-container {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.progress-track {
  width: 7rem;
  height: 0.375rem;
  border-radius: 9999px;
  background: var(--color-border);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 9999px;
  background: var(--color-primary);
  transition: width 700ms ease;
}

.progress-text {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-primary);
}

// Dismiss button — mínimo 44px de touch target
.dismiss-btn {
  font-size: 0.75rem;
  color: var(--color-muted);
  background: transparent;
  border: none;
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;        // ~44px alto en la mayoría de viewports
  min-height: 2.75rem;            // 44px explícito
  cursor: pointer;
  transition: color 0.15s, background 0.15s;

  &:hover {
    color: var(--color-text);
    background: var(--color-card);
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
}

// Steps grid
.steps-grid {
  display: grid;
  gap: 0.5rem;
  grid-template-columns: 1fr;

  @media (min-width: 640px) {
    grid-template-columns: 1fr 1fr;
  }
}

// Step item — button para accesibilidad de teclado
.step-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border-radius: 0.75rem;
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  cursor: default;
  transition: background 0.15s, border-color 0.15s;
  width: 100%;

  &.step-completed {
    opacity: 0.5;
  }

  &.step-pending {
    cursor: pointer;

    &:hover {
      background: var(--color-card);
      border-color: var(--color-border);
    }

    &:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
  }

  &:disabled {
    cursor: default;
  }
}

// Indicator circle / checkmark
.step-indicator {
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  border: 2px solid var(--color-border);
  background: var(--color-card);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.3s, border-color 0.3s, transform 0.3s;

  &--done {
    background: var(--color-primary);
    border-color: var(--color-primary);
    transform: scale(1.05);
  }
}

.step-content {
  flex: 1;
  min-width: 0;
}

.step-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text);
  margin: 0;

  &--done {
    text-decoration: line-through;
    color: var(--color-muted);
  }
}

.step-description {
  font-size: 0.75rem;
  color: var(--color-muted);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.step-chevron {
  color: var(--color-muted);
  flex-shrink: 0;
}
```

---

### 4.6 Integración en el Dashboard

```typescript
// dashboard.component.ts
import { Component } from '@angular/core';
import { OnboardingCardComponent } from '../../components/onboarding-card/onboarding-card.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [OnboardingCardComponent],
  template: `
    <div class="dashboard-layout">
      <!-- Header -->
      <app-dashboard-header />

      <!-- Onboarding — se auto-oculta -->
      <app-onboarding-card />

      <!-- Resto del dashboard -->
      <app-metrics-grid />
      <app-quick-actions />
      <app-recent-activity />
    </div>
  `
})
export class DashboardComponent {}
```

---

## 5. Flujo de datos completo

```
USUARIO LLEGA AL DASHBOARD
        │
        ▼
GET /api/onboarding/status
        │
        ▼
 ┌──────────────────────────────────────────────────┐
 │  OnboardingService.GetStatusAsync(userId)         │
 │                                                    │
 │  Parallel queries a NeonDB (EF Core):             │
 │  ├── UserOnboardings WHERE user_id = {userId}     │
 │  ├── ApiKeys COUNT WHERE user_id = {userId}       │
 │  ├── Messages COUNT WHERE user_id = {userId}      │
 │  ├── Domains ANY WHERE verified = true            │
 │  ├── OrganizationMembers COUNT                    │
 │  └── UserBillings.Plan                            │
 └──────────────────────────────────────────────────┘
        │
        ▼
 Devuelve: { dismissed, completedCount, totalSteps, steps[] }
        │
        ▼
 Angular: status signal actualizado
        │
        ▼
 showCard = !dismissed && !allCompleted
        │
        ├── true  → renderiza OnboardingCard
        └── false → oculta card silenciosamente

USUARIO HACE CLIC EN UN STEP
        │
        ▼
 router.navigateByUrl(step.href)
 (el usuario realiza la acción — ej. crea API key)
        │
        ▼
 Al volver al dashboard → ngOnInit() → loadStatus()
 → step aparece como completado

USUARIO HACE CLIC EN "DISMISS"
        │
        ▼
PATCH /api/onboarding/dismiss
        │
        ▼
 DB: user_onboarding.dismissed = true
        │
        ▼
 Signal actualizado → showCard = false → card se oculta
```

---

## 6. Checklist de calidad UX/UI

Antes de considerar el onboarding como completo, verificar:

### Funcionalidad
- [ ] El estado `dismissed` persiste en base de datos (no solo en memoria/localStorage)
- [ ] Todos los steps calculan su completitud desde datos reales del backend
- [ ] Los steps condicionales (por plan) se evalúan correctamente
- [ ] Al completar todos los steps, la card se oculta automáticamente
- [ ] El dismiss funciona sin recargar la página
- [ ] Refreshing la página mantiene el estado correcto (dismissed/not dismissed)

### Accesibilidad (WCAG 2.1 AA)
- [ ] Los steps clickeables son elementos `<button>` (no `<div>` con onClick)
- [ ] La progress bar tiene `role="progressbar"` con `aria-valuenow/min/max`
- [ ] El botón Dismiss tiene `aria-label` descriptivo
- [ ] El contador "X of Y" tiene `aria-live="polite"` para screen readers
- [ ] Todos los elementos interactivos tienen `focus-visible` con outline visible
- [ ] La navegación por teclado (Tab + Enter) funciona en todos los steps

### Touch & Interacción
- [ ] El botón Dismiss tiene mínimo `44×44px` de área de toque
- [ ] Los steps tienen mínimo `44px` de alto como touch target
- [ ] Existe feedback visual en hover y focus en items clickeables

### Rendimiento
- [ ] Las queries al backend se lanzan en paralelo (`Task.WhenAll`)
- [ ] Existe un estado de carga (skeleton o spinner) mientras se obtienen datos
- [ ] La progress bar tiene `transition` suave (no snap)
- [ ] NeonDB connection pooling habilitado para evitar latencia por cold starts

### Diseño
- [ ] La card desaparece limpiamente (sin salto de layout) cuando se descarta
- [ ] Los steps completados muestran estado visual diferenciado (check + opacidad)
- [ ] Los steps pendientes con href muestran chevron como affordance de click
- [ ] La card no bloquea ni interfiere con el contenido del dashboard

---

*Documento generado a partir de la auditoría de Sendix Frontend — 2026-06-10*