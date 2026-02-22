/** Shared types for the butler-core WebSocket event contract, HA device/tool registry, and session state. Imported by both server (Nitro) and client (Vue). */

export type SessionState = 'IDLE' | 'LISTENING' | 'THINKING' | 'EXECUTING' | 'SPEAKING'

export interface Tool {
  name: string
  description: string
  domain: string
  service: string
}

/** A single controllable entity belonging to a Device. */
export interface ControlEntity {
  entityId: string
  domain: string
  state: string
  friendlyName: string
}

/** A physical HA device with its controllable entities and interactability flag. */
export interface Device {
  deviceId: string
  name: string
  area: string            // resolved area name; empty string if device has no area
  manufacturer?: string
  model?: string
  entities: ControlEntity[]
  interactable: boolean
}

export interface ToolRegistry {
  tools: Tool[]
  devices: Device[]
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
  /** data is a base64-encoded audio buffer; decode with atob() on the client */
  | { type: 'audio'; data: string; format: 'mp3' | 'wav' }
  | { type: 'error'; message: string }
  | { type: 'pong' }

// WebSocket messages: client → server (text frames only)
export type ClientMessage =
  | { type: 'ping' }
  | { type: 'clear_history' }
  | { type: 'command'; text: string }
