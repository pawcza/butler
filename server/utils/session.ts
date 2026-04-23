import { randomUUID } from 'node:crypto'
import type { SessionState } from '~/shared/types'
import { CONVERSATION_ID_PATTERN } from '~/shared/text'

export class SessionManager {
  private state: SessionState = 'IDLE'
  private readonly onStateChange: (state: SessionState) => void
  private ttsModel: string | null = null
  private ttsVoice: string | null = null
  /** Stable ID passed to Hermes as `conversation`, so it chains turns and keeps the prompt cache warm. Client can override via `set_conversation` so the thread persists across refresh. */
  private conversationId: string = `butler-${randomUUID()}`

  constructor(onStateChange: (state: SessionState) => void) {
    this.onStateChange = onStateChange
  }

  getConversationId(): string {
    return this.conversationId
  }

  setConversationId(id: string): boolean {
    // Accept only well-formed client-supplied ids to avoid injection into Hermes paths.
    if (!CONVERSATION_ID_PATTERN.test(id)) return false
    this.conversationId = id
    return true
  }

  setTtsPreferences(model: string, voice: string): void {
    this.ttsModel = model
    this.ttsVoice = voice
  }

  getTtsModel(): string | null {
    return this.ttsModel
  }

  getTtsVoice(): string | null {
    return this.ttsVoice
  }

  setState(state: SessionState): void {
    this.state = state
    this.onStateChange(state)
  }

  getState(): SessionState {
    return this.state
  }
}
