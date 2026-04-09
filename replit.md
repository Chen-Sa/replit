# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Dual-compatible OpenAI/Anthropic reverse proxy API with a simple frontend portal.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite (api-portal)

## Architecture

### API Server (`artifacts/api-server`)
- Mounted at `/api` (health + proxy routes) and `/v1` (OpenAI-compatible proxy)
- Auth token: fixed `2222222222` via Bearer header
- Proxies requests to Anthropic via Replit AI Integrations
- Supports `/v1/models`, `/v1/chat/completions` (streaming and non-streaming)
- Model mapping: OpenAI model names mapped to Claude equivalents

### API Portal (`artifacts/api-portal`)
- Simple React + Vite frontend at `/`
- Shows "OK - API Server is running" status page

## Environment Variables

- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` - Anthropic proxy URL (auto-injected)
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY` - Anthropic API key (auto-injected)
- `SESSION_SECRET` - Session secret

## Key Commands

- `pnpm run typecheck` - full typecheck across all packages
- `pnpm run build` - typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` - regenerate API hooks and Zod schemas
- `pnpm --filter @workspace/api-server run dev` - run API server
- `pnpm --filter @workspace/api-portal run dev` - run frontend portal

## Testing

```bash
curl localhost:80/v1/models -H "Authorization: Bearer 2222222222"
curl localhost:80/api/healthz
```
