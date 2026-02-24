/** Shared types for the butler-core WebSocket event contract and session state. Imported by both server (Nitro) and client (Vue). */

export type SessionState = 'IDLE' | 'LISTENING' | 'THINKING' | 'EXECUTING' | 'SPEAKING'

export interface ButlerTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
}

// Ollama native tool calling types
export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> }
}

export interface OllamaTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

// WebSocket events: server -> client
export type ServerEvent =
  | { type: 'state'; state: SessionState }
  | { type: 'transcript'; text: string }
  | { type: 'response'; text: string }
  /** data is a base64-encoded audio buffer; decode with atob() on the client */
  | { type: 'audio'; data: string; format: 'mp3' | 'wav' }
  | { type: 'error'; message: string }
  | { type: 'pong' }

// WebSocket messages: client -> server (text frames only)
export type ClientMessage =
  | { type: 'ping' }
  | { type: 'clear_history' }
  | { type: 'command'; text: string }
