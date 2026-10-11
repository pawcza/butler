import type { SessionState } from '~/shared/types'

export class SessionManager {
  private state: SessionState = 'IDLE'
  private readonly onStateChange: (state: SessionState) => void
  private ttsModel: string | null = null
  private ttsVoice: string | null = null
  /** conversation-api thread id; null until the first message opens one — every session starts clean. */
  private conversationId: string | null = null

  constructor(onStateChange: (state: SessionState) => void) {
    this.onStateChange = onStateChange
  }

  getConversationId(): string | null {
    return this.conversationId
  }

  setConversationId(id: string | null): void {
    this.conversationId = id
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
