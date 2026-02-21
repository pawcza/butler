export type SessionState = 'IDLE' | 'LISTENING' | 'THINKING' | 'EXECUTING' | 'SPEAKING'

export interface Tool {
  name: string
  description: string
  domain: string
  service: string
}

export interface Entity {
  entityId: string
  domain: string
  friendlyName: string
  state: string
  area?: string
  interactable: boolean
}

export interface ToolRegistry {
  tools: Tool[]
  entities: Entity[]
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
}

// WebSocket events: server → client
export type ServerEvent =
  | { type: 'state'; state: SessionState }
  | { type: 'transcript'; text: string }
  | { type: 'response'; text: string }
  | { type: 'audio'; data: string; format: 'mp3' | 'wav' }
  | { type: 'error'; message: string }
  | { type: 'pong' }

// WebSocket messages: client → server (text frames only)
export type ClientMessage =
  | { type: 'ping' }
  | { type: 'clear_history' }
