# SendIX Backend API

Express.js API server for SendIX, handling business logic, Supabase integration, and email services.

## Setup

```bash
npm install
cp .env.example .env
# Update .env with your configuration
```

## Development

```bash
npm run dev
```

Server runs on `http://localhost:3001`

## Build & Production

```bash
npm run build
npm start
```

## API Endpoints

- `GET /` - API info
- `GET /api/health` - Health check
- `GET /api/hello` - Sample endpoint

## Architecture

- `src/server.ts` - Express app setup
- `src/routes/` - API route handlers
- `src/lib/` - Utility libraries (Supabase client)
- `src/services/` - Business logic (Email service)
- `src/types/` - TypeScript definitions
