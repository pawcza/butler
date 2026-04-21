/** Shared types for the butler-core WebSocket event contract and session state. Imported by both server (Nitro) and client (Vue). */

export type SessionState = 'IDLE' | 'LISTENING' | 'THINKING' | 'EXECUTING' | 'SPEAKING'

/** Single chat message sent to Hermes (OpenAI chat completions shape). */
export interface HermesMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// WebSocket events: server -> client
export type ServerEvent =
  | { type: 'state'; state: SessionState }
  | { type: 'transcript'; text: string }
  | { type: 'response'; text: string }
  /** Streaming response tokens from the LLM */
  | { type: 'response_start' }
  | { type: 'response_delta'; text: string }
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
