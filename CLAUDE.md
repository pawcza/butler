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

- `server/routes/ws.ts`: WebSocket at `/ws`, one `SessionManager` per peer. Microphone audio streams in as a capture: `audio_start`, binary PCM frames, then `audio_end` (or `audio_cancel`). A capture opens while the session is IDLE, when only speech is left of the turn (barge-in: the speech is stopped and the old turn is superseded), or while the model is still writing (the turn is superseded and its signal aborts the LLM request and any tool wait; a refused `audio_start` is answered with `capture_refused`). `stop_speech` drops the rest of the turn's speech. Closing the socket drops the capture and aborts the running turn, including a final transcription pass in flight; a closed session never starts a turn. Binary frames over the size a capture can legitimately send (the first: the 10 s pre-roll ring, later: 100 ms) are dropped, and so are JSON text frames over `MAX_JSON_FRAME_BYTES`. The wake word upload (`server/api/wakeword.post.ts`) is read bounded by `MAX_WAKE_UPLOAD_BYTES` and answered 413 beyond it. Nitro's Node preset creates the socket server itself, so the library's frame limit can't be set from here.
- `server/utils/live-transcription.ts`: `LiveTranscription`, one capture. While audio arrives it re-transcribes the whole buffer for partial transcripts, one pass at a time, none before 1 s of audio, then every 0.5 s; `finish` runs the final pass. The transcriber is injected, so it tests without Nitro.
- `server/utils/pipeline.ts`: one turn. `openCapture` and `processCapture` turn a capture into partials and a final transcript, then `processCommand` opens or loads the thread, calls `respond`, hands each message block to a `SpeechQueue` and stores the turn.
- `server/utils/llm.ts`: streaming `/chat/completions` client and the tool loop. `respond` emits blocks through `BlockHandlers`. Message text is split on `\n` into one block per paragraph, and `onSpeakChunk(blockId, text)` fires as each one closes, with the block's full text.
- `server/utils/mcp.ts`: `McpToolbox`, the only `ToolProvider`. Connects to `MCP_SERVERS`, prefixes tool names as `<server>__<tool>`, reconnects dropped servers on later turns.
- `server/utils/conversations.ts`: JSON file store, one file per thread under `DATA_DIR/conversations`. Atomic writes, a queue per thread.
- `server/utils/speech-queue.ts`: `SpeechQueue`, the speech of one turn. Splits a block into sentences (`shared/speech.ts`; the turn's first sentence is split in two at a clause boundary when long), sends the engine the spoken words only (markdown stripped), synthesizes two at a time, emits `audio` events strictly in order with the block id and character range each one reads, and shows the "Warming up the speech model" tool-style bubble when the next sentence has waited over 2 s. `stop` aborts in-flight requests, drops pending sentences and emits no audio after it. A `SpeechEngineDownError` (unreachable, timed out) or a second failure of any kind in the turn does the same: one error is shown, the rest of the turn's speech is dropped, and the next turn starts a new queue. The synthesizer is injected, so it tests without Nitro.
- `server/utils/stt.ts`, `tts.ts`: OpenAI-shaped speech clients. Both are optional. `tts-warmup.ts` is the `TTS_WARMUP` throttle: one throwaway synthesis at turn start, none within 30 s of a finished one.
- `server/utils/session.ts`: per-socket state, plus the turn bookkeeping for speech: the stop hook, "only speech is left" (the model has finished), and turn ids so a superseded turn can't idle the session.
- `server/api/capabilities.get.ts`: what the page must know up front (whether speech recognition is configured).
- `server/utils/config.ts`: validates env vars with Zod at module load and exits on failure.
- `server/plugins/startup.ts`: connects MCP and warms up STT without blocking startup.
- `shared/types.ts`: the WebSocket event contract and stored thread types. `shared/speech.ts`: sentence splitting and the word-timing estimate. `shared/audio.ts`: the PCM format and the binary frame tag.
- `composables/useVoice.ts`: client audio, VAD, wake word and WebSocket state. One microphone stream, opened once and kept open, feeds both the VAD and `worklets/pcm-capture.ts`.
- `worklets/pcm-capture.ts`: AudioWorklet that resamples the microphone to 16 kHz mono Int16 in 100 ms frames, using `StreamResampler` from `utils/pcm.ts`. The client keeps the last seconds in a `PcmRing` for pre-roll.
- `utils/speech-player.ts`: client playback of the `audio` clips: decoded on arrival and scheduled on the AudioContext clock (`source.start(when)`), each where the one before ends; pause (suspends the AudioContext), stop, and the estimated spoken-word progress that `components/ChatLog.vue` renders as marks through `renderInlineMarkdown(text, marks)`.
- `composables/useAvatarState.ts`, `components/ButlerScene.vue`, `shaders/`, `utils/shapes.ts`, `utils/plexus.ts`: the plexus avatar (points and nearest-neighbour lines, positioned on the GPU by one shared GLSL chunk).

## Rules

- Nitro auto-imports `server/utils/`, but modules covered by tests import each other explicitly so vitest can load them without Nitro.
- Chat completions is stateless. Butler sends history on each request through `buildMessages`, and only user and assistant text is stored. Tool calls are shown live and not persisted.
- Every session starts clean: the first message opens a thread, `?c=<id>` reopens one. A thread that no longer exists falls back to a new one.
- Failed tool calls go back to the model as tool results. Never retry one: it may have had a real-world effect.
- A failing MCP server must never stop Butler, and with none configured no `tools` field is sent.
- Don't send optional request fields such as `stream_options`. Not all compatible servers accept them, and nothing here needs usage data. `user` (the OIDC `sub`, or `LLM_USER`) and `metadata.locale` (`LLM_LOCALE`) go out only when set, and an empty `LLM_SYSTEM_PROMPT` sends no system message.
- A persona server sends its named SSE events only when asked (`x-persona-events: 1`, sent when `LLM_PERSONA_EVENTS=1`); without it the stream is plain OpenAI. Named events are ignored, except `persona.tool_activity` (a server running tools itself: shown as a tool call block) and `persona.reset` (drops the open paragraph and the stored reply so far; paragraphs already shown and spoken stay).
- All base URLs include `/v1`.
- The client's IDLE state follows the server, not audio playback: playback can finish while a tool loop is still running.
- Butler speaks with the configured voice only (`TTS_MODEL`, `TTS_VOICE`, `TTS_VOICES` by language of the block). There is no per-user voice.
- Stop is client-first: playback is silenced at once, queued clips dropped, then `stop_speech` tells the server. Clips already in flight are ignored until the next `response_start`. After a stop the turn still ends normally and its text is stored.
- A press to talk over speech stops it and opens a capture. While the model is still writing (`isStreaming`) the capture also interrupts the turn on the server: the LLM request and any tool wait are aborted, the reply text so far stays in the bubble and is stored if non-empty, and a tool call in flight is never re-run.
- Speech gets the words, not the markdown: `spokenMask` (`shared/speech.ts`) says which characters of a block are read, the engine is sent those, and the ranges on `audio` events and the word timing stay on the displayed text (the estimator weighs only spoken characters).
- Sentence ranges are offsets into the block text exactly as `block_end` sends it. Highlighting estimates word times from the clip duration; there are no word timestamps.
- A push-to-talk release keeps streaming for 200 ms before `audio_end`; a press inside that tail cancels it and the same capture goes on. From `audio_end` until the next server state event the client opens no capture and shows no LISTENING (`isCapturing` is what the page shows), and `capture_refused` clears the client's capture state. After a bare wake word the UI shows LISTENING.
- The microphone is opened once and never re-acquired per utterance. The VAD gets the shared stream through `getStream`/`pauseStream`/`resumeStream`, and its `pauseStream` must not stop the tracks.
- A suspended AudioContext (autoplay policy, no gesture yet, as in the wake word flow) never blocks the session: the player waits for the next pointer or key press, is not `active` meanwhile so the UI follows the server, and then plays the queued clips; a user pause is told apart by `paused`. The mic context is resumed on any gesture too.
- A capture starts with pre-roll from the ring buffer: the last 600 ms on a push-to-talk press, everything since the wake word ended after a bare wake word. Anything said before the press survives.
- Binary frames start with `AUDIO_FRAME_TAG` (0x01) and JSON with `{`. The Node adapter doesn't say whether a frame was text or binary, so the first byte decides.
- Speech-to-text uses only the plain OpenAI `POST /audio/transcriptions` with WAV, for partials and finals alike. No server-specific streaming endpoints.
- A passive VAD segment that overlapped a capture, playback or a non-IDLE state never goes to the wake word check: it is butler's own voice or the user's command.

## TypeScript strictness

`nuxt.config.ts` enables `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride` and `noPropertyAccessFromIndexSignature`.

- Don't pass `undefined` for optional fields. Use a conditional spread: `...(val !== undefined ? { key: val } : {})`.
- All array and record access must be null-checked.

## Testing

Tests never call a real model. `tests/support/mock-openai.ts` scripts streaming responses, and `tests/support/mcp-fixture.ts` is a real MCP server over stdio or HTTP. Add a parser case to `tests/llm.test.ts` whenever a server turns out to behave differently.
