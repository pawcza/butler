# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # tsx watch — hot-reload, no compile step
npm run build        # tsup → dist/index.js (ESM, node22 target)
npm run start        # run the compiled dist/index.js
npm run type-check   # tsc --noEmit (no tests exist; this is the verification step)
npm run lint         # eslint src
npm run format       # prettier --write src
```

There are no tests. `type-check` + manual `POST /command` calls are the primary verification tools.

## Architecture

### Request flow

Two entry points, both feed the same pipeline:

1. **WebSocket** (binary frame) → `ws/server.ts` → `processAudio()` → STT → `processCommand()`
2. **REST** `POST /command` → `routes/command.ts` → `processCommand()` (skips STT)

`processCommand()` in `pipeline/index.ts`:
```
LLM (Ollama) → validate() → execute() or speak plain text → TTS (Speaches) → audio out
```

### Pipeline stages (`src/pipeline/`)

| File | Role |
|------|------|
| `stt.ts` | POST audio to Speaches `/v1/audio/transcriptions` |
| `llm.ts` | POST to Ollama (non-streaming, returns raw string) |
| `validator.ts` | Extract JSON from LLM output, validate tool names + entity IDs against registry |
| `executor.ts` | Map tool names → HA domain/service, call HA API sequentially, never throws |
| `tts.ts` | POST text to Speaches `/v1/audio/speech`, returns audio Buffer |

### Key design rules (from DECISIONS.md)

- **Registry validation before execution**: `validator.ts` rejects hallucinated entity IDs / tool names before the executor ever runs. HA is never called with garbage.
- **System prompt rebuilt per call**: `buildSystemPrompt(registry)` is called every LLM invocation so `POST /registry/refresh` takes effect immediately without restart.
- **No streaming**: Ollama called with `stream: false` — partial JSON validation is impossible.
- **IDLE guard**: WebSocket handler rejects new audio if session state ≠ `IDLE`. No queue. User must wait.
- **Conversation history cap**: 20 messages (10 exchanges) per session, then oldest pair is dropped.

### Session state machine

`IDLE → LISTENING → THINKING → EXECUTING → SPEAKING → IDLE`

`SessionManager` (`src/session/manager.ts`) is one instance per WebSocket connection, scoped to that connection's lifetime.

### Tool registry (`src/ha/toolRegistry.ts`)

- Module-level singleton `registry` (`{ tools, entities }`)
- `buildRegistry()` fetches all HA states + area names, filters to `SUPPORTED_DOMAINS` (`light`, `cover`, `climate`, `scene`, `switch`), and populates it
- Entity field is `entityId` (camelCase) in `Entity` interface; `entity_id` (snake_case) is HA's wire format
- Adding a new HA capability requires: adding to `TOOL_DEFINITIONS`, `SUPPORTED_DOMAINS`, and `TOOL_SERVICE_MAP` in `executor.ts`

### REST endpoints

| Route | Purpose |
|-------|---------|
| `GET /health` | Liveness probe |
| `GET /registry` | Dump current tool/entity registry as JSON |
| `POST /registry/refresh` | Re-fetch from HA and rebuild registry (no restart needed) |
| `POST /command` | Text-only pipeline — body: `{ text: string }` — returns `{ events: PipelineEvent[] }` |
| `GET /` | Static UI from `public/` directory |

## TypeScript strictness

`tsconfig.json` has `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`. Consequences:
- Never pass `undefined` for optional fields — omit the key entirely (use conditional spread `...(val !== undefined ? { key: val } : {})`)
- Fastify server must be typed as `Fastify<Server, IncomingMessage, ServerResponse>` to avoid Http2SecureServer union conflict
- WebSocket `data` in `on('message')` is `Buffer | ArrayBuffer | Buffer[]` — handle all three with if/else

## Environment variables

Required at startup (Zod fails fast with clear messages if missing):
- `HA_URL`, `HA_TOKEN` — Home Assistant
- `OLLAMA_URL`, `OLLAMA_MODEL` (default: `qwen2.5:7b`)
- `WHISPER_URL`, `WHISPER_MODEL` (default: `whisper-1`) — STT via Speaches
- `PIPER_URL`, `PIPER_MODEL`, `PIPER_VOICE`, `PIPER_RESPONSE_FORMAT` (`mp3`|`wav`) — TTS via Speaches

`WHISPER_URL` and `PIPER_URL` both point to the same Speaches instance. Kept separate to allow splitting later.

## Docker / network

- `docker-compose.yml` uses `proxynet` (Unraid's NginxProxyManager bridge, `external: true`)
- butler-core ↔ Speaches: Docker hostname (`speaches:8000`)
- butler-core ↔ HA (RPi) and Ollama (home server PC): plain LAN IPs
- Build: `Dockerfile` → `dist/index.js` via tsup; `public/` is copied in
