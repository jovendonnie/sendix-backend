# Sendix — Guía de Despliegue en Digital Ocean (Droplet)

> Guía completa y precisa para desplegar Sendix (Frontend + Backend) en un Droplet de Digital Ocean usando Docker, GHCR y CI/CD con GitHub Actions.

---

## Tabla de Contenidos

1. [Arquitectura de Producción](#1-arquitectura-de-producción)
2. [Prerrequisitos](#2-prerrequisitos)
3. [Configuración Inicial del Droplet](#3-configuración-inicial-del-droplet)
4. [Instalación de Docker en el Droplet](#4-instalación-de-docker-en-el-droplet)
5. [Configuración del Firewall](#5-configuración-del-firewall)
6. [Estructura de Archivos en el Servidor](#6-estructura-de-archivos-en-el-servidor)
7. [Archivos de Configuración de Producción](#7-archivos-de-configuración-de-producción)
   - [docker-compose.prod.yml](#71-docker-composeprodyml)
   - [Traefik (Reverse Proxy + SSL)](#72-traefik-reverse-proxy--ssl-automático)
   - [nginx.conf del Frontend](#73-nginxconf-del-frontend-producción)
8. [Variables de Entorno en el Servidor](#8-variables-de-entorno-en-el-servidor)
9. [Configuración de GitHub y GHCR](#9-configuración-de-github-y-ghcr)
   - [Secrets del Repositorio Frontend](#91-secrets-del-repositorio-frontend)
   - [Secrets del Repositorio Backend](#92-secrets-del-repositorio-backend)
10. [GitHub Actions — Workflows CI/CD](#10-github-actions--workflows-cicd)
    - [Workflow del Frontend](#101-workflow-del-frontend)
    - [Workflow del Backend](#102-workflow-del-backend)
11. [Despliegue Inicial Manual](#11-despliegue-inicial-manual)
12. [Configuración DNS](#12-configuración-dns)
13. [Verificación del Despliegue](#13-verificación-del-despliegue)
14. [Comandos Útiles](#14-comandos-útiles)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Arquitectura de Producción

```
Internet
   │
   ▼ :80 / :443
┌─────────────────────────────────────────────┐
│              Traefik (Reverse Proxy)         │
│          SSL automático (Let's Encrypt)      │
└────────────────────┬────────────────────────┘
                     │ Internal Docker Network: sendix_net
          ┌──────────┴──────────┐
          ▼                     ▼
┌─────────────────┐   ┌──────────────────────┐
│ sendix-frontend  │   │   sendix-backend      │
│  (nginx:alpine)  │   │  (node:20-alpine)     │
│  Puerto: 80      │   │  Puerto: 3001         │
│  /api/* → backend│   │  Express.js API       │
└─────────────────┘   └──────────────────────┘
          │                     │
          └──────────┬──────────┘
                     ▼
          ┌──────────────────────┐
          │    Supabase (externo) │
          │  Auth + PostgreSQL    │
          └──────────────────────┘

Repositorios GHCR:
  ghcr.io/<tu-usuario>/sendix-frontend:latest
  ghcr.io/<tu-usuario>/sendix-backend:latest
```

**Stack de producción:**
- **Frontend:** React 19 + Vite → servido por Nginx Alpine
- **Backend:** Express.js + TypeScript → Node.js 20 Alpine
- **Base de datos:** Supabase (gestionada externamente, no en el Droplet)
- **Proxy / SSL:** Traefik v2 con Let's Encrypt automático
- **Registry:** GitHub Container Registry (GHCR)
- **CI/CD:** GitHub Actions

---

## 2. Prerrequisitos

### Local
- [ ] Git instalado
- [ ] Repositorios en GitHub:
  - `github.com/<tu-usuario>/sendix-frontend`
  - `github.com/<tu-usuario>/sendix-backend`
- [ ] Dominio apuntando al IP del Droplet (ej: `sendix.com`, `api.sendix.com`)

### Digital Ocean
- [ ] Droplet creado con:
  - **OS:** Ubuntu 22.04 LTS x64
  - **Plan mínimo:** 2 GB RAM / 1 vCPU / 50 GB SSD (recomendado 4 GB para holgura)
  - **Datacenter:** El más cercano a tus usuarios
- [ ] IP pública del Droplet anotada
- [ ] Acceso SSH root configurado

### Cuentas externas
- [ ] Supabase project activo con `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Stripe con claves configuradas
- [ ] Proveedor de email (Resend API key o SMTP configurado)

---

## 3. Configuración Inicial del Droplet

### 3.1 Conexión SSH inicial

```bash
ssh root@<IP_DEL_DROPLET>
```

### 3.2 Actualización del sistema

```bash
apt update && apt upgrade -y
apt install -y curl git wget unzip htop nano ufw
```

### 3.3 Crear usuario de deploy (no usar root en producción)

```bash
# Crear usuario
adduser deploy

# Agregar al grupo sudo
usermod -aG sudo deploy

# Copiar SSH keys del root al nuevo usuario
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/authorized_keys
mv /home/deploy/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

### 3.4 Verificar acceso SSH con el nuevo usuario

```bash
# Desde tu máquina local (nueva terminal)
ssh deploy@<IP_DEL_DROPLET>
```

### 3.5 Deshabilitar login root por SSH (opcional pero recomendado)

```bash
# Como root
sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart sshd
```

---

## 4. Instalación de Docker en el Droplet

Ejecutar como usuario `deploy` (o root si aún no cambiaste):

```bash
# Instalar dependencias
sudo apt install -y ca-certificates curl gnupg lsb-release

# Agregar GPG key oficial de Docker
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# Agregar repositorio de Docker
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Instalar Docker Engine + Docker Compose v2
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Agregar usuario deploy al grupo docker
sudo usermod -aG docker deploy

# Verificar instalación
docker --version
docker compose version
```

> **IMPORTANTE:** Cierra sesión SSH y vuelve a conectar para que el grupo `docker` tome efecto.

```bash
exit
ssh deploy@<IP_DEL_DROPLET>

# Verificar que funciona sin sudo
docker ps
```

### 4.1 Habilitar Docker al inicio del sistema

```bash
sudo systemctl enable docker
sudo systemctl enable containerd
```

---

## 5. Configuración del Firewall

```bash
# Habilitar UFW
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Permitir SSH
sudo ufw allow ssh
sudo ufw allow 22/tcp

# Permitir HTTP y HTTPS (para Traefik)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Activar firewall
sudo ufw enable

# Verificar estado
sudo ufw status verbose
```

---

## 6. Estructura de Archivos en el Servidor

### 6.1 Crear los directorios

El directorio `/opt` pertenece a `root`, por lo que se debe usar `sudo` para crear la estructura y luego transferir la propiedad al usuario `deploy`:

```bash
# Crear toda la estructura con sudo
sudo mkdir -p /opt/sendix/traefik/acme
sudo mkdir -p /opt/sendix/backend

# Transferir propiedad al usuario deploy (para poder escribir sin sudo)
sudo chown -R deploy:deploy /opt/sendix

# Verificar que el permiso fue aplicado correctamente
ls -la /opt/ | grep sendix
# Resultado esperado: drwxr-xr-x ... deploy deploy ... sendix
```

### 6.2 Verificar que tienes acceso sin sudo

```bash
touch /opt/sendix/test && rm /opt/sendix/test && echo "Permisos OK"
# Resultado esperado: Permisos OK
```

### 6.3 Estructura final en el servidor

```
/opt/sendix/
├── docker-compose.prod.yml      # Orquestación principal
├── traefik/
│   ├── traefik.yml              # Configuración de Traefik
│   └── acme/
│       └── acme.json            # Certificados SSL (auto-generado, permisos 600)
└── backend/
    └── .env                     # Variables de entorno del backend (NO subir a git)
```

---

## 7. Archivos de Configuración de Producción

Aquí se crean los 3 archivos de configuración directamente desde el terminal del Droplet usando comandos `cat`. No necesitas un editor de texto — solo **copia, reemplaza los valores marcados con `←` y pega en la terminal**.

---

### 7.1 `docker-compose.prod.yml`

Copia el bloque completo y pégalo en el terminal del Droplet tal como está — los valores ya están configurados para tu proyecto.

```bash
cat > /opt/sendix/docker-compose.prod.yml << 'EOF'
version: "3.9"

networks:
  sendix_net:
    driver: bridge
  traefik_net:
    external: true

services:

  traefik:
    image: traefik:v2.11
    container_name: traefik
    restart: unless-stopped
    networks:
      - traefik_net
      - sendix_net
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /opt/sendix/traefik/traefik.yml:/traefik.yml:ro
      - /opt/sendix/traefik/acme/acme.json:/acme.json
    labels:
      - "traefik.enable=true"

  backend:
    image: ghcr.io/jovendonnie/sendix-backend:latest
    container_name: sendix-backend
    restart: unless-stopped
    networks:
      - sendix_net
    env_file:
      - ./backend/.env
    environment:
      - NODE_ENV=production
      - PORT=3001
    expose:
      - "3001"
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3001/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    labels:
      - "traefik.enable=false"

  frontend:
    image: ghcr.io/jovendonnie/sendix-frontend:latest
    container_name: sendix-frontend
    restart: unless-stopped
    networks:
      - sendix_net
      - traefik_net
    depends_on:
      backend:
        condition: service_healthy
    expose:
      - "80"
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=traefik_net"
      - "traefik.http.routers.sendix-http.rule=Host(`sendix.lat`) || Host(`www.sendix.lat`)"
      - "traefik.http.routers.sendix-http.entrypoints=web"
      - "traefik.http.routers.sendix-http.middlewares=redirect-to-https"
      - "traefik.http.routers.sendix-https.rule=Host(`sendix.lat`) || Host(`www.sendix.lat`)"
      - "traefik.http.routers.sendix-https.entrypoints=websecure"
      - "traefik.http.routers.sendix-https.tls=true"
      - "traefik.http.routers.sendix-https.tls.certresolver=letsencrypt"
      - "traefik.http.services.sendix-frontend.loadbalancer.server.port=80"
      - "traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https"
      - "traefik.http.middlewares.redirect-to-https.redirectscheme.permanent=true"
EOF
```

Verificar que el archivo fue creado correctamente:

```bash
cat /opt/sendix/docker-compose.prod.yml
```

---

### 7.2 Traefik — Reverse Proxy + SSL Automático

**Paso 1 — Crear el archivo de configuración de Traefik:**

Copia el bloque completo y pégalo en el terminal del Droplet tal como está — el email ya está configurado.

```bash
cat > /opt/sendix/traefik/traefik.yml << 'EOF'
global:
  checkNewVersion: false
  sendAnonymousUsage: false

log:
  level: INFO

accessLog: {}

api:
  dashboard: false

entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: traefik_net

certificatesResolvers:
  letsencrypt:
    acme:
      email: marinstvvnn@gmail.com
      storage: /acme.json
      httpChallenge:
        entryPoint: web
EOF
```

**Paso 2 — Crear y asegurar el archivo de certificados SSL:**

> Traefik requiere que `acme.json` exista con permisos exactamente `600`, de lo contrario rechaza iniciar.

```bash
touch /opt/sendix/traefik/acme/acme.json
chmod 600 /opt/sendix/traefik/acme/acme.json

# Verificar permisos
ls -la /opt/sendix/traefik/acme/
# Resultado esperado: -rw------- 1 deploy deploy 0 ... acme.json
```

**Paso 3 — Crear la red externa de Docker para Traefik:**

```bash
docker network create traefik_net

# Verificar que fue creada
docker network ls | grep traefik_net
```

**Paso 4 — Verificar todos los archivos de Traefik:**

```bash
cat /opt/sendix/traefik/traefik.yml
ls -la /opt/sendix/traefik/acme/acme.json
```

---

### 7.3 `nginx.conf` del Frontend (Producción)

Este archivo **no va en el servidor** — va en el repositorio del frontend (`sendix-frontend/frontend/nginx.conf`) y se copia dentro de la imagen Docker durante el build.

El archivo ya existe en tu proyecto. Verifica que su contenido sea el siguiente. Si necesitas editarlo, hazlo en tu máquina local y haz commit:

```nginx
server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml application/javascript application/json image/svg+xml;

    # Proxy hacia el backend (por red interna Docker)
    location /api/ {
        proxy_pass http://backend:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /unsubscribe {
        proxy_pass http://backend:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Cache de assets estáticos
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

### 7.4 Verificación final de la estructura

Ejecuta esto para confirmar que todos los archivos están en su lugar:

```bash
find /opt/sendix -type f | sort
```

Resultado esperado:

```
/opt/sendix/backend/.env
/opt/sendix/docker-compose.prod.yml
/opt/sendix/traefik/acme/acme.json
/opt/sendix/traefik/traefik.yml
```

---

## 8. Variables de Entorno en el Servidor

### 8.1 Backend `.env`

Crear el archivo `/opt/sendix/backend/.env` directamente en el servidor:

```bash
nano /opt/sendix/backend/.env
```

Contenido del archivo (reemplaza con tus valores reales):

```env
# ─── Server ───────────────────────────────────────────
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://sendix.lat
CORS_ORIGINS=https://sendix.lat,https://www.sendix.lat

# ─── Supabase ─────────────────────────────────────────
SUPABASE_URL=https://xxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1...

# ─── Email Provider ───────────────────────────────────
# Opciones: 'resend' | 'smtp'
EMAIL_PROVIDER=resend

# Resend (si EMAIL_PROVIDER=resend)
RESEND_API_KEY=re_xxxxxxxxxxxx

# SMTP (si EMAIL_PROVIDER=smtp)
# SMTP_HOST=smtp.sendix.lat
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=user@sendix.lat
# SMTP_PASS=tu_contraseña_smtp
# SMTP_FROM_DOMAIN=sendix.lat
# SMTP_FROM_NAME=Sendix
# SMTP_DKIM_DOMAIN=sendix.lat
# SMTP_DKIM_SELECTOR=mail
# SMTP_DKIM_PRIVATE_KEY=base64_o_pem_de_tu_clave_dkim

# ─── Stripe ───────────────────────────────────────────
STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxx
STRIPE_PRICE_PRO=price_xxxxxxxxxxxx
STRIPE_PRICE_AGENCY=price_xxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
```

### 8.2 Variables de Entorno del Frontend (Build-time)

El frontend de Vite usa variables `VITE_*` que se **inyectan en tiempo de build**, no en tiempo de ejecución. Estas se configuran como **GitHub Secrets** y se pasan al `docker build` durante el CI/CD (ver sección 10).

```
VITE_API_URL=https://sendix.lat
VITE_SUPABASE_URL=https://xxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1...
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_xxxxxxxxxxxx
VITE_APP_URL=https://sendix.lat
VITE_GOOGLE_GENAI_KEY=AIzaSy...        # opcional
```

### 8.3 Asegurar permisos del .env

```bash
chmod 600 /opt/sendix/backend/.env
chown deploy:deploy /opt/sendix/backend/.env
```

---

## 9. Configuración de GitHub y GHCR

### 9.1 Habilitar GHCR en tu cuenta

GHCR (GitHub Container Registry) está habilitado por defecto. Las imágenes se publicarán en:
- `ghcr.io/<tu-usuario>/sendix-frontend`
- `ghcr.io/<tu-usuario>/sendix-backend`

### 9.2 Generar SSH Key para el Deploy

En el Droplet (como usuario `deploy`):

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_actions -N ""
cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/github_actions      # ← Copia este valor (clave PRIVADA) para GitHub Secrets
```

### 9.3 Secrets del Repositorio Frontend

En GitHub → `sendix-frontend` → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret Name | Valor |
|---|---|
| `VITE_API_URL` | `https://sendix.lat` |
| `VITE_SUPABASE_URL` | `https://xxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `eyJhbGci...` (clave anon pública de Supabase) |
| `VITE_STRIPE_PUBLISHABLE_KEY` | `pk_live_xxx` |
| `VITE_APP_URL` | `https://sendix.lat` |
| `VITE_GOOGLE_GENAI_KEY` | Tu clave de Google GenAI (si usas IA) |
| `DROPLET_HOST` | `<IP_DEL_DROPLET>` |
| `DROPLET_USER` | `deploy` |
| `DROPLET_SSH_KEY` | Contenido completo de `~/.ssh/github_actions` (clave privada) |

### 9.4 Secrets del Repositorio Backend

En GitHub → `sendix-backend` → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret Name | Valor |
|---|---|
| `DROPLET_HOST` | `<IP_DEL_DROPLET>` |
| `DROPLET_USER` | `deploy` |
| `DROPLET_SSH_KEY` | Mismo contenido de la clave privada SSH |

> El backend no necesita secrets de build porque todas sus variables se leen del archivo `/opt/sendix/backend/.env` en el servidor en tiempo de ejecución.

---

## 10. GitHub Actions — Workflows CI/CD

### 10.1 Workflow del Frontend

Crear el archivo en el repositorio frontend:
**`.github/workflows/deploy.yml`**

```yaml
name: Build and Deploy Frontend

on:
  push:
    branches:
      - main

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository_owner }}/sendix-frontend
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

jobs:
  build-and-push:
    name: Build Docker Image & Push to GHCR
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    outputs:
      image_tag: ${{ steps.meta.outputs.tags }}

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3.4.0
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract Docker metadata
        id: meta
        uses: docker/metadata-action@v5.7.0
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,prefix=sha-

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3.10.0

      - name: Build and push Docker image
        uses: docker/build-push-action@v6.16.0
        with:
          context: ./frontend
          file: ./frontend/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            VITE_API_URL=${{ secrets.VITE_API_URL }}
            VITE_SUPABASE_URL=${{ secrets.VITE_SUPABASE_URL }}
            VITE_SUPABASE_ANON_KEY=${{ secrets.VITE_SUPABASE_ANON_KEY }}
            VITE_STRIPE_PUBLISHABLE_KEY=${{ secrets.VITE_STRIPE_PUBLISHABLE_KEY }}
            VITE_APP_URL=${{ secrets.VITE_APP_URL }}
            VITE_GOOGLE_GENAI_KEY=${{ secrets.VITE_GOOGLE_GENAI_KEY }}

  deploy:
    name: Deploy to Digital Ocean Droplet
    runs-on: ubuntu-latest
    needs: build-and-push
    environment: production

    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.2.2
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: ${{ secrets.DROPLET_USER }}
          key: ${{ secrets.DROPLET_SSH_KEY }}
          script: |
            cd /opt/sendix

            # Autenticarse en GHCR con el token de GitHub Actions
            echo "${{ secrets.GITHUB_TOKEN }}" | \
              docker login ghcr.io -u ${{ github.actor }} --password-stdin

            # Pull de la nueva imagen del frontend
            docker pull ghcr.io/${{ github.repository_owner }}/sendix-frontend:latest

            # Reiniciar solo el contenedor del frontend
            docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate frontend

            # Limpiar imágenes antiguas
            docker image prune -f
```

> **Nota:** Para que las `VITE_*` variables lleguen al `Dockerfile`, el Dockerfile del frontend debe aceptarlas como `ARG`. Ver sección [Modificación del Dockerfile del Frontend](#modificación-del-dockerfile-del-frontend).

#### Modificación del Dockerfile del Frontend

Editar `sendix-frontend/frontend/Dockerfile` para aceptar los `ARG` de build:

```dockerfile
# ─── Stage 1: Build ───────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Build-time arguments para variables Vite
ARG VITE_API_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_STRIPE_PUBLISHABLE_KEY
ARG VITE_APP_URL
ARG VITE_GOOGLE_GENAI_KEY

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_STRIPE_PUBLISHABLE_KEY=$VITE_STRIPE_PUBLISHABLE_KEY
ENV VITE_APP_URL=$VITE_APP_URL
ENV VITE_GOOGLE_GENAI_KEY=$VITE_GOOGLE_GENAI_KEY

RUN npm run build

# ─── Stage 2: Serve ───────────────────────────────────
FROM nginx:stable-alpine AS runtime

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

### 10.2 Workflow del Backend

Crear el archivo en el repositorio backend:
**`.github/workflows/deploy.yml`**

```yaml
name: Build and Deploy Backend

on:
  push:
    branches:
      - main

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository_owner }}/sendix-backend
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

jobs:
  build-and-push:
    name: Build Docker Image & Push to GHCR
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3.4.0
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract Docker metadata
        id: meta
        uses: docker/metadata-action@v5.7.0
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,prefix=sha-

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3.10.0

      - name: Build and push Docker image
        uses: docker/build-push-action@v6.16.0
        with:
          context: ./backend
          file: ./backend/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    name: Deploy to Digital Ocean Droplet
    runs-on: ubuntu-latest
    needs: build-and-push
    environment: production

    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: ${{ secrets.DROPLET_USER }}
          key: ${{ secrets.DROPLET_SSH_KEY }}
          script: |
            cd /opt/sendix

            # Autenticarse en GHCR
            echo "${{ secrets.GITHUB_TOKEN }}" | \
              docker login ghcr.io -u ${{ github.actor }} --password-stdin

            # Pull de la nueva imagen del backend
            docker pull ghcr.io/${{ github.repository_owner }}/sendix-backend:latest

            # Reiniciar solo el contenedor del backend
            docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate backend

            # Limpiar imágenes antiguas
            docker image prune -f
```

---

## 11. Despliegue Inicial Manual

Una vez que todo está configurado, sigue estos pasos por primera vez:

### 11.1 Autenticar Docker en GHCR desde el Droplet

Las imágenes en GHCR son **privadas por defecto**. El Droplet necesita un Personal Access Token (PAT) para poder hacer `docker pull`.

**Crear el PAT en GitHub:**
1. GitHub → tu avatar → **Settings**
2. Baja hasta **Developer settings** → **Personal access tokens** → **Tokens (classic)**
3. Clic en **Generate new token (classic)**
4. Nombre: `droplet-ghcr-read`
5. Expiration: `No expiration`
6. Marca el scope: ✅ `read:packages`
7. Clic en **Generate token** y copia el valor (`ghp_xxxx...`)

**Autenticar en el Droplet** (reemplaza `ghp_TUTOKEN` con el token copiado):

```bash
echo "ghp_TUTOKEN" | docker login ghcr.io -u jovendonnie --password-stdin
# Resultado esperado: Login Succeeded
```

### 11.2 Pull de las imágenes iniciales

```bash
cd /opt/sendix

docker pull ghcr.io/<jovendonnie>/sendix-frontend:latest
docker pull ghcr.io/<jovendonnie>/sendix-backend:latest
```

> Si las imágenes aún no existen, haz un push al branch `main` de cada repo para que los workflows de GitHub Actions las construyan y suban a GHCR primero.

### 11.3 Levantar los servicios

```bash
cd /opt/sendix

docker compose -f docker-compose.prod.yml up -d

# Ver estado de los contenedores
docker compose -f docker-compose.prod.yml ps

# Ver logs en tiempo real
docker compose -f docker-compose.prod.yml logs -f
```

### 11.4 Verificar que Traefik obtiene el certificado SSL

```bash
# Esperar ~30 segundos y verificar
docker compose -f docker-compose.prod.yml logs traefik | grep -i "certificate\|acme\|error"
```

---

## 12. Configuración DNS

En el panel de tu registrador de dominio (o Digital Ocean DNS):

| Tipo | Nombre | Valor | TTL |
|------|--------|-------|-----|
| `A` | `@` | `<IP_DEL_DROPLET>` | 3600 |
| `A` | `www` | `<IP_DEL_DROPLET>` | 3600 |

> Espera entre 5 y 60 minutos para la propagación del DNS antes de que Let's Encrypt pueda emitir el certificado.

---

## 13. Verificación del Despliegue

### 13.1 Verificar contenedores corriendo

```bash
docker compose -f /opt/sendix/docker-compose.prod.yml ps
```

Resultado esperado:

```
NAME                 IMAGE                                              STATUS
sendix-backend       ghcr.io/<usuario>/sendix-backend:latest           Up (healthy)
sendix-frontend      ghcr.io/<usuario>/sendix-frontend:latest          Up
traefik              traefik:v2.11                                     Up
```

### 13.2 Verificar health check del backend

```bash
curl http://localhost:3001/
# Esperado: respuesta 200 con info del API
```

### 13.3 Verificar el frontend desde el navegador

```
https://sendix.lat            → Debe cargar la landing page
https://sendix.lat/api/health → Debe responder el health check del backend
```

### 13.4 Verificar el certificado SSL

```bash
curl -I https://sendix.lat
# Esperado: HTTP/2 200 con headers de Traefik
```

### 13.5 Verificar logs del backend

```bash
docker logs sendix-backend --tail 50
```

---

## 14. Comandos Útiles

### Ver logs en tiempo real

```bash
# Todos los servicios
docker compose -f /opt/sendix/docker-compose.prod.yml logs -f

# Solo backend
docker logs -f sendix-backend

# Solo frontend
docker logs -f sendix-frontend

# Solo traefik
docker logs -f traefik
```

### Reiniciar servicios

```bash
cd /opt/sendix

# Reiniciar un servicio específico
docker compose -f docker-compose.prod.yml restart backend
docker compose -f docker-compose.prod.yml restart frontend

# Reiniciar todo
docker compose -f docker-compose.prod.yml restart
```

### Detener y levantar todo

```bash
cd /opt/sendix

# Detener
docker compose -f docker-compose.prod.yml down

# Levantar
docker compose -f docker-compose.prod.yml up -d
```

### Actualizar una imagen manualmente

```bash
cd /opt/sendix

docker pull ghcr.io/<usuario>/sendix-backend:latest
docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate backend
docker image prune -f
```

### Ver uso de recursos

```bash
docker stats --no-stream
```

### Entrar al contenedor del backend

```bash
docker exec -it sendix-backend sh
```

### Ver variables de entorno activas del backend

```bash
docker exec sendix-backend env | grep -v DKIM  # excluye la clave privada DKIM
```

---

## 15. Troubleshooting

### El frontend no puede conectar al backend

**Causa:** El nginx del frontend no puede resolver el hostname `backend`.

**Solución:** Ambos contenedores deben estar en la misma red Docker (`sendix_net`). Verificar:

```bash
docker network inspect sendix_net
# Debe listar sendix-frontend y sendix-backend como miembros
```

### Traefik no obtiene el certificado SSL

**Causas posibles:**
1. El dominio no apunta al IP del Droplet aún (DNS sin propagar)
2. El puerto 80 no está abierto en el firewall
3. El archivo `acme.json` no tiene permisos `600`

```bash
# Verificar DNS
nslookup sendix.lat

# Verificar puerto 80
sudo ufw status

# Corregir permisos
chmod 600 /opt/sendix/traefik/acme/acme.json

# Reiniciar traefik
docker compose -f /opt/sendix/docker-compose.prod.yml restart traefik
```

### El workflow de GitHub Actions falla al hacer SSH

**Causa:** El secret `DROPLET_SSH_KEY` no tiene el contenido correcto.

**Verificación:** El contenido debe incluir cabecera y pie:

```
-----BEGIN OPENSSH PRIVATE KEY-----
[contenido base64]
-----END OPENSSH PRIVATE KEY-----
```

**Solución:** Regenerar la clave y actualizar el secret:

```bash
# En el Droplet
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_actions -N ""
cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/github_actions  # Copiar TODO el contenido al secret DROPLET_SSH_KEY
```

### El backend no inicia (variables de entorno faltantes)

```bash
docker logs sendix-backend | head -30
```

Si dice `Error: ... is not defined` o similar, revisar el archivo `/opt/sendix/backend/.env` y asegurarse de que todas las variables requeridas están presentes.

### Las variables `VITE_*` no están en producción

**Causa:** Las variables de Vite se incrustan en el bundle en tiempo de build. Si no se pasaron como `build-args` en el Dockerfile, el bundle tendrá `undefined`.

**Solución:** Verificar que los GitHub Secrets están configurados en el repositorio frontend y que el workflow los pasa como `build-args` al `docker build`.

### Stripe webhooks no funcionan

**Causa:** Stripe necesita una URL pública HTTPS para enviar webhooks.

**Solución:**
1. Configurar en el panel de Stripe: `https://sendix.lat/api/billing/webhook`
2. Actualizar `STRIPE_WEBHOOK_SECRET` en `/opt/sendix/backend/.env` con el secret del nuevo webhook endpoint
3. Reiniciar el backend: `docker compose -f /opt/sendix/docker-compose.prod.yml restart backend`

### Limpiar espacio en disco

```bash
# Ver uso de disco de Docker
docker system df

# Limpiar imágenes, contenedores y volúmenes sin uso
docker system prune -a --volumes
```

---

## Resumen del Flujo CI/CD

```
Push a main (frontend o backend)
         │
         ▼
GitHub Actions (ubuntu-latest)
  1. Checkout del código
  2. Login en GHCR
  3. docker build (con variables de entorno inyectadas via ARG)
  4. docker push → ghcr.io/<usuario>/sendix-{frontend,backend}:latest
         │
         ▼ (SSH via appleboy/ssh-action)
Digital Ocean Droplet (/opt/sendix)
  1. docker pull → nueva imagen
  2. docker compose up -d --force-recreate
  3. docker image prune -f
         │
         ▼
Servicio actualizado sin downtime del otro servicio
```

---

*Guía generada para el proyecto Sendix — Stack: React 19 + Vite + Express.js + TypeScript + Supabase + Docker + Traefik*