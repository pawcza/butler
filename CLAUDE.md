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
- `server/utils/mcp.ts` — MCP client singleton connecting to ha-mcp for HA tool discovery and execution
- `server/api/` — REST endpoints (file-based routing: `health.get.ts` → GET /api/health)
- `server/routes/ws.ts` — WebSocket handler at /ws (Nitro native crossws)
- `server/plugins/startup.ts` — connects to MCP server at server start
- `pages/` — Vue pages (index.vue = voice interface)
- `components/` — auto-imported Vue components
- `composables/` — auto-imported Vue composables
- `shared/types.ts` — TypeScript types shared between frontend and backend

## Key architectural rules

- Conversations live in conversation-api (`/v1/conversations`, `server/utils/conversations.ts`). Every session starts clean; the first message opens a thread, `?c=<id>` reopens one. The thread id is also the Hermes conversation name (`butler-<id>`), so a new thread is a clean Hermes context.
- Nitro auto-imports everything in `server/utils/` — no import statements needed between server files
- `server/utils/config.ts` validates env vars with Zod at module load time; exits process on failure
- HA tool discovery and execution goes through ha-mcp MCP server — butler-core is an MCP client
- Ollama native tool calling (`tools` param in `/api/chat`) — no text-based JSON parsing
- `server/utils/pipeline.ts` — agentic loop: LLM → tool calls → execute → feed results → LLM interprets
- `server/utils/registry.ts` — merges MCP tools + butler tools into Ollama tool format
- Butler tools (timers, news) are executed server-side; weather/calendar handled by ha-mcp
- WebSocket IDLE guard: binary audio frames rejected if session state ≠ IDLE (no queue, user must wait)
- System prompt is personality-only; tools are passed via Ollama `tools` API parameter

## TypeScript strictness

`nuxt.config.ts` enables: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`.

- Never pass `undefined` for optional fields — omit the key with conditional spread `...(val !== undefined ? { key: val } : {})`
- All array/record access must be null-checked (noUncheckedIndexedAccess)

## Environment variables

All read from process.env by `server/utils/config.ts`. Nuxt loads `.env` automatically in dev.

| Var | Default | Purpose |
|-----|---------|---------|
| `HERMES_API_URL` | `http://hermes-agent:8642/v1` | Hermes agent (does the LLM, tools, HA) |
| `HERMES_API_KEY` | — | Hermes API server key |
| `PERSONA_API_URL` | `http://conversation-api:3001/v1` | conversation-api home-app door — conversation threads live there |
| `PERSONA_API_KEY` | — | butler's key from conversation-api `LLM_PROXY_KEYS` |
| `WHISPER_URL` | — | Whisper API URL (STT, model configured in Docker) |
| `PIPER_URL` | — | Speaches URL (TTS) |
| `PIPER_MODEL` | `speaches-ai/Kokoro-82M-v1.0-ONNX` | TTS model |
| `PIPER_VOICE` | `af_heart` | TTS voice |
| `PIPER_RESPONSE_FORMAT` | `mp3` | Audio output format (`mp3` or `wav`) |
