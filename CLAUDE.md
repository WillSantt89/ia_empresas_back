# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

Always respond in Portuguese (pt-BR).

## Project Overview

Multi-tenant SaaS platform for AI agents serving WhatsApp customers. Two projects:
- **Backend** (`ia_empresas_back/backend/`): Node.js + Fastify 4, PostgreSQL 15, Redis 7, Google Gemini AI
- **Frontend** (`ia_empresas_front/`): Next.js 14, TypeScript, TanStack Query, shadcn/ui, Tailwind CSS

## Commands

### Backend (`cd ia_empresas_back/backend`)
```bash
npm run dev              # Start with --watch (auto-reload)
npm start                # Production start
npm run migrate          # Run database migrations
npm run migrate:down     # Rollback migrations
npm run seed             # Populate initial data (plans, master user)
npm run diagnose         # System diagnostics
npm test                 # Run tests (node --test)
npm run lint             # ESLint
```

### Frontend (`cd ia_empresas_front`)
```bash
npm run dev              # Next.js dev server
npm run build            # Production build
npm run lint             # Next.js lint
npm run type-check       # TypeScript check (tsc --noEmit)
```

### Infrastructure
```bash
# From ia_empresas_back/
docker compose up -d                    # Start PostgreSQL + Redis + Backend
docker compose --profile tools up -d    # + pgAdmin (5050) + Redis Commander (8081)
```

## Architecture

### Message Processing Flow
```
WhatsApp → Meta → n8n Flow 1 → POST /api/webhooks/n8n → Gemini AI → POST n8n Flow 2 → Meta → WhatsApp
```

### Human Control Flow (Chatwoot ↔ n8n ↔ Backend)
```
Chatwoot assign   → n8n detecta → POST /api/webhooks/n8n/controle-humano { acao: "assumir" }   → IA pausa
Chatwoot unassign → n8n detecta → POST /api/webhooks/n8n/controle-humano { acao: "devolver" }  → IA retoma (sync msgs Chatwoot→Redis)
Chatwoot resolved → n8n detecta → POST /api/webhooks/n8n/controle-humano { acao: "encerrar" }  → conversa finalizada, Redis arquivado
```

### Multi-Tenancy
Every data table references `empresa_id`. The tenant middleware (`src/middleware/tenant.js`) enforces isolation automatically. Master users can impersonate companies via `X-Empresa-ID` header.

### Role Hierarchy
`master` → `admin` → `operador` → `viewer` (most to least privileges)

### AI Agent Pipeline (backend)
1. Webhook receives message → validates auth token
2. Resolves agent (by `agent_id` or first active for company)
3. Gets API keys with automatic failover across multiple keys
4. Loads conversation history from Redis (`conv:{empresa_id}:{conversation_key}`)
5. Calls Gemini with function calling loop (max 5 iterations)
6. Tool runner executes HTTP tools, transforms results for LLM
7. Checks transfer rules (keyword, tool_result, menu_opcao triggers)
8. Logs to `mensagens_log`, increments `uso_diario_agente`, records analytics

### Key Backend Services
- `services/gemini.js` — Gemini API via `@google/genai` SDK, function calling loop, Gemini 3 thoughtSignature, context caching (`ai.caches.*`)
- `services/api-key-manager.js` — AES-256 encrypted keys, failover, rate limit tracking
- `services/memory.js` — Redis-based conversation history (24h TTL), archive (30d), Chatwoot sync
- `services/tool-runner.js` — HTTP tool executor with timeout and result transformation
- `services/chatwoot.js` — Chatwoot API client, send/get messages, assign/unassign agents

### Key Backend Middleware Stack
`rate-limit → auth (JWT) → tenant → permission → route handler`

### Frontend Patterns
- Pages in `src/app/(dashboard)/dashboard/*/page.tsx` — all are client components (`"use client"`)
- API client in `src/lib/api.ts` — auto token refresh on 401, base URL from `NEXT_PUBLIC_API_URL`
- Auth context in `src/contexts/auth-context.tsx` — wraps TanStack Query
- Forms use react-hook-form + zod validation
- TanStack Query: staleTime 5min, gcTime 15min, retry 3x (skip 4xx)

## Database

PostgreSQL with 33+ migrations in `ia_empresas_back/backend/migrations/`. Key tables:
- `empresas` → `agentes` → `agente_tools` → `tools` (agent configuration chain)
- `api_keys` (per agent, encrypted, with failover priority)
- `conversas` → `mensagens_log` (conversation tracking). Status: `ativo`, `finalizado`, `timeout`
- `conversas.controlado_por`: `ia` or `humano` — controls whether AI responds
- `controle_historico` — audit trail for human control changes
- `config_controle_humano` — per-company settings (timeout, return message, commands)
- `uso_diario_agente`, `uso_mensal`, `conversacao_analytics` (usage/billing)
- `agente_transferencias` (inter-agent transfer rules)
- `agentes.cache_enabled`, `gemini_cache_id`, `cache_expires_at` (context caching)

UUIDs for PKs, TIMESTAMPTZ for timestamps, `is_active`/`ativo` for soft deletes.

## Environment

Backend requires: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (32+ chars), `ENCRYPTION_KEY` (exactly 32 chars for AES-256), `PORT`
Frontend requires: `NEXT_PUBLIC_API_URL`

See `ia_empresas_back/backend/.env.example` and `ia_empresas_front/.env.example`.

## Webhook Authentication

- **n8n webhook**: `X-Webhook-Token` header validated against `empresas.webhook_token`
- **Chatwoot webhook**: HMAC signature in `X-Chatwoot-Signature` header
- **Chat API**: `X-Api-Key` header validated against `api_keys` table

## n8n Webhook Endpoints

- `POST /api/webhooks/n8n` — Main message processing (WhatsApp → AI → response)
- `POST /api/webhooks/n8n/confirmar-envio` — Confirm message sent (saves wamid)
- `POST /api/webhooks/n8n/controle-humano` — Human control: `{ phone, acao: "assumir"|"devolver"|"encerrar" }`

## Default Credentials (dev only)

Master: `admin@plataforma.com` / `admin123`
Demo: `admin@empresa-demo.com` / `admin123`
