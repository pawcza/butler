/** Shared types for the WebSocket event contract and session state. Imported by both server (Nitro) and client (Vue). */

export type SessionState = 'IDLE' | 'LISTENING' | 'THINKING' | 'EXECUTING' | 'SPEAKING'

/** A block is one item of a response: a tool call, a tool result, or a paragraph of assistant text. */
export type BlockKind = 'tool_call' | 'tool_output' | 'message'

/** A stored conversation thread. */
export interface ConversationSummary {
  id: string
  title: string | null
  messageCount: number
  createdAt: string
  lastMessageAt: string
}

export interface ConversationPage {
  items: ConversationSummary[]
  hasMore: boolean
}

/** One stored turn — what was said and what butler answered. Tool calls are only shown live. */
export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface ConversationThread {
  conversation: ConversationSummary
  items: StoredMessage[]
}

// WebSocket events: server -> client
export type ServerEvent =
  | { type: 'state'; state: SessionState }
  | { type: 'transcript'; id: string; text: string }
  /** Full final assistant text — pushed once at the end of a response, used for exchange history. */
  | { type: 'response'; text: string }
  /** Start of a new response (one user turn can emit many blocks). */
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
  /** A fresh thread was opened for this session's first message. */
  | { type: 'conversation'; conversation: ConversationSummary }

// TTS model info returned by /api/tts/voices
export interface TtsModelInfo {
  id: string
  voices: readonly string[]
}

// WebSocket messages: client -> server (text frames only)
export type ClientMessage =
  | { type: 'ping' }
  | { type: 'command'; text: string }
  | { type: 'set_voice'; model: string; voice: string }
  /** Continue an existing thread, or `null` to start clean (the default for every new session). */
  | { type: 'set_conversation'; id: string | null }
