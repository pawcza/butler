# CLAUDE.md

Guidance for Claude Code when working in this repository. Start with `README.md` for what the project is and how to configure it.

## Commands

```bash
pnpm dev          # Nuxt dev server with HMR (frontend + backend)
pnpm build        # Build for production into .output/
pnpm start        # Run the production build, reading .env
pnpm type-check   # nuxt typecheck (vue-tsc over the full project)
pnpm test         # vitest run
pnpm mock         # OpenAI-shaped mock server on port 4010
```

`pnpm install` runs `nuxt prepare`. Tests fail without the generated `.nuxt/tsconfig.json`.

## Architecture

Single Nuxt 3 project. Nitro is the backend (REST + WebSocket), Vue the frontend.

- `server/routes/ws.ts`: WebSocket at `/ws`, one `SessionManager` per peer. Binary audio frames are rejected unless the session is IDLE. Closing the socket aborts the running turn.
- `server/utils/pipeline.ts`: one turn. Transcribe, open or load the thread, call `respond`, chain TTS, store the turn.
- `server/utils/llm.ts`: streaming `/chat/completions` client and the tool loop. `respond` emits blocks through `BlockHandlers`. Message text is split on `\n` into one block per paragraph, and `onSpeakChunk` fires as each one closes.
- `server/utils/mcp.ts`: `McpToolbox`, the only `ToolProvider`. Connects to `MCP_SERVERS`, prefixes tool names as `<server>__<tool>`, reconnects dropped servers on later turns.
- `server/utils/conversations.ts`: JSON file store, one file per thread under `DATA_DIR/conversations`. Atomic writes, a queue per thread.
- `server/utils/stt.ts`, `tts.ts`: OpenAI-shaped speech clients. Both are optional.
- `server/utils/config.ts`: validates env vars with Zod at module load and exits on failure.
- `server/plugins/startup.ts`: connects MCP and warms up STT without blocking startup.
- `shared/types.ts`: the WebSocket event contract and stored thread types.
- `composables/useVoice.ts`: client audio, VAD, wake word and WebSocket state.
- `composables/useAvatarState.ts`, `components/ButlerScene.vue`, `shaders/`, `utils/shapes.ts`: the particle avatar.

## Rules

- Nitro auto-imports `server/utils/`, but modules covered by tests import each other explicitly so vitest can load them without Nitro.
- Chat completions is stateless. Butler sends history on each request through `buildMessages`, and only user and assistant text is stored. Tool calls are shown live and not persisted.
- Every session starts clean: the first message opens a thread, `?c=<id>` reopens one. A thread that no longer exists falls back to a new one.
- Failed tool calls go back to the model as tool results. Never retry one: it may have had a real-world effect.
- A failing MCP server must never stop Butler, and with none configured no `tools` field is sent.
- Don't send optional request fields such as `stream_options`. Not all compatible servers accept them, and nothing here needs usage data.
- All base URLs include `/v1`.
- The client's IDLE state follows the server, not audio playback: playback can finish while a tool loop is still running.

## TypeScript strictness

`nuxt.config.ts` enables `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride` and `noPropertyAccessFromIndexSignature`.

- Don't pass `undefined` for optional fields. Use a conditional spread: `...(val !== undefined ? { key: val } : {})`.
- All array and record access must be null-checked.

## Testing

Tests never call a real model. `tests/support/mock-openai.ts` scripts streaming responses, and `tests/support/mcp-fixture.ts` is a real MCP server over stdio or HTTP. Add a parser case to `tests/llm.test.ts` whenever a server turns out to behave differently.
