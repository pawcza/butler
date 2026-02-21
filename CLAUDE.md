# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Nuxt dev server with HMR (frontend + backend)
pnpm build        # Build for production → .output/
pnpm start        # Run production build: node .output/server/index.mjs
pnpm type-check   # nuxt typecheck (runs vue-tsc on the full project)
pnpm test         # vitest run (unit tests in tests/)
pnpm test:watch   # vitest watch mode
```

## Architecture

Single Nuxt 3 project. Nitro handles backend (REST + WebSocket). Vue handles frontend.

- `server/utils/` — backend logic (Nitro auto-imports these; no explicit imports needed in server files)
- `server/api/` — REST endpoints (file-based routing: `health.get.ts` → GET /api/health)
- `server/routes/ws.ts` — WebSocket handler at /ws (Nitro native crossws)
- `server/plugins/startup.ts` — runs buildRegistry() at server start
- `pages/` — Vue pages (index.vue = voice interface, entities.vue = entity manager)
- `components/` — auto-imported Vue components
- `composables/` — auto-imported Vue composables
- `shared/types.ts` — TypeScript types shared between frontend and backend

## Key architectural rules

- Nitro auto-imports everything in `server/utils/` — no import statements needed between server files
- `server/utils/config.ts` validates env vars with Zod at module load time; exits process on failure
- Entity interactability is stored in `data/entities.json` (gitignored); defaults to interactable: true for new entities
- Only interactable entities reach the LLM system prompt — non-interactable ones cannot be called even if hallucinated
- WebSocket IDLE guard: binary audio frames rejected if session state ≠ IDLE (no queue, user must wait)
- System prompt is rebuilt on every LLM call so POST /api/entities/refresh takes effect immediately

## TypeScript strictness

`nuxt.config.ts` enables: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`.

- Never pass `undefined` for optional fields — omit the key with conditional spread `...(val !== undefined ? { key: val } : {})`
- All array/record access must be null-checked (noUncheckedIndexedAccess)
- Entity field is `entityId` (camelCase) in shared types; `entity_id` (snake_case) is HA's wire format only

## Environment variables

All read from process.env by `server/utils/config.ts`. Nuxt loads `.env` automatically in dev.

| Var | Default | Purpose |
|-----|---------|---------|
| `HA_URL` | — | Home Assistant base URL |
| `HA_TOKEN` | — | HA long-lived access token |
| `OLLAMA_URL` | — | Ollama base URL |
| `OLLAMA_MODEL` | `qwen2.5:7b` | LLM model |
| `WHISPER_URL` | — | Speaches URL (STT) |
| `WHISPER_MODEL` | `whisper-1` | STT model |
| `PIPER_URL` | — | Speaches URL (TTS) |
| `PIPER_MODEL` | `Stoned-Code/piper-en_US-glados-medium` | TTS model |
| `PIPER_VOICE` | `glados` | TTS voice |
| `PIPER_RESPONSE_FORMAT` | `mp3` | Audio output format (`mp3` or `wav`) |
