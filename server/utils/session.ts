import type { SessionState } from '~/shared/types'

/**
 * Single Hermes conversation name for every butler request. Hermes's
 * named-conversation semantics guarantee all turns chain under one session id
 * (see `/docs/user-guide/features/api-server/#named-conversations`), so every
 * device talking to butler is continuing the same thread.
 */
const BUTLER_CONVERSATION = 'butler'

export class SessionManager {
  private state: SessionState = 'IDLE'
  private readonly onStateChange: (state: SessionState) => void
  private ttsModel: string | null = null
  private ttsVoice: string | null = null

  constructor(onStateChange: (state: SessionState) => void) {
    this.onStateChange = onStateChange
  }

  getConversationId(): string {
    return BUTLER_CONVERSATION
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
