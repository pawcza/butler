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
  /** What has been heard so far of the utterance still being spoken. Replaced by later partials. */
  | { type: 'transcript_partial'; id: string; text: string }
  /** The final transcript. For a spoken utterance it has the same id as its partials. */
  | { type: 'transcript'; id: string; text: string }
  /** The utterance was dropped (noise, hallucination, failed or cancelled): remove its partial. */
  | { type: 'transcript_discarded'; id: string }
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
  /** The block is gone: a passing notice (waiting for the speech model) that has nothing left to say. */
  | { type: 'block_remove'; blockId: string }
  /** Response finished. `text` is the final spoken message body (empty if the model returned no message). */
  | { type: 'response_end'; text: string }
  /**
   * One spoken sentence. `data` is a base64-encoded audio buffer; decode with atob() on the client.
   * `block` says which message block it reads and which characters of that block's text, for the
   * highlight. Speech that belongs to no block (a spoken fallback) has none. Events arrive in order.
   */
  | { type: 'audio'; data: string; format: 'mp3' | 'wav'; block?: { id: string; start: number; end: number } }
  | { type: 'error'; message: string }
  /**
   * The server did not open the capture `audio_start` asked for (it is busy). The client drops its
   * capture state: the frames it sends are ignored and no `audio_end` is wanted.
   */
  | { type: 'capture_refused' }
  /** A fresh thread was opened for this session's first message. */
  | { type: 'conversation'; conversation: ConversationSummary }

// WebSocket messages: client -> server, as JSON. Microphone audio goes between `audio_start` and
// `audio_end` as binary frames tagged with AUDIO_FRAME_TAG (see shared/audio.ts).
export type ClientMessage =
  | { type: 'command'; text: string }
  /**
   * Open a capture. Accepted while the session is IDLE, when only speech is left of the turn
   * (barge-in), or while the model is still writing (the running turn is interrupted: its request is
   * aborted, what it wrote is kept and stored). Otherwise answered with `capture_refused`.
   */
  | { type: 'audio_start' }
  /** Close the capture and answer what was said. */
  | { type: 'audio_end' }
  /** Close the capture and drop it. */
  | { type: 'audio_cancel' }
  /**
   * Drop the rest of this turn's speech: pending and in-flight synthesis is aborted. The reply text
   * keeps streaming and is stored as usual.
   */
  | { type: 'stop_speech' }
  /** Continue an existing thread, or `null` to start clean (the default for every new session). */
  | { type: 'set_conversation'; id: string | null }
