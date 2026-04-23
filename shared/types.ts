/** Shared types for the butler-core WebSocket event contract and session state. Imported by both server (Nitro) and client (Vue). */

export type SessionState = 'IDLE' | 'LISTENING' | 'THINKING' | 'EXECUTING' | 'SPEAKING'

/** A block is one item in Hermes's /v1/responses output: a tool call, a tool result, or a final assistant message. */
export type BlockKind = 'tool_call' | 'tool_output' | 'message'

// WebSocket events: server -> client
export type ServerEvent =
  | { type: 'state'; state: SessionState }
  | { type: 'transcript'; text: string }
  /** Full final assistant text — pushed once at the end of a response, used for exchange history. */
  | { type: 'response'; text: string }
  /** Start of a new Hermes response (one user turn can emit many blocks). */
  | { type: 'response_start' }
  /** A new block began streaming. For tool_call, `tool` is the tool name. */
  | { type: 'block_start'; blockId: string; kind: BlockKind; tool?: string }
  /** Incremental text appended to a block (only message blocks stream text). */
  | { type: 'block_delta'; blockId: string; text: string }
  /** Block finalized — `text` is the complete body. */
  | { type: 'block_end'; blockId: string; text: string }
  /** Response finished. `text` is the final spoken message body (empty if the model returned no message). */
  | { type: 'response_end'; text: string }
  /** data is a base64-encoded audio buffer; decode with atob() on the client */
  | { type: 'audio'; data: string; format: 'mp3' | 'wav' }
  | { type: 'error'; message: string }
  | { type: 'pong' }

// TTS model info returned by /api/tts/voices
export interface TtsModelInfo {
  id: string
  voices: readonly string[]
}

// WebSocket messages: client -> server (text frames only)
export type ClientMessage =
  | { type: 'ping' }
  | { type: 'clear_history' }
  | { type: 'command'; text: string }
  | { type: 'set_voice'; model: string; voice: string }
  /** Client-controlled Hermes conversation id — persisted in localStorage so the thread survives refresh. */
  | { type: 'set_conversation'; id: string }
