import type { SessionState } from '~/shared/types'

export class SessionManager {
  private state: SessionState = 'IDLE'
  private readonly onStateChange: (state: SessionState) => void
  private ttsModel: string | null = null
  private ttsVoice: string | null = null
  /** Thread id; null until the first message opens one, so every session starts clean. */
  private conversationId: string | null = null
  private turn: AbortController | null = null

  constructor(onStateChange: (state: SessionState) => void) {
    this.onStateChange = onStateChange
  }

  getConversationId(): string | null {
    return this.conversationId
  }

  setConversationId(id: string | null): void {
    this.conversationId = id
  }

  /** Starts a turn. Its signal fires if the client goes away mid-response. */
  beginTurn(): AbortSignal {
    this.turn = new AbortController()
    return this.turn.signal
  }

  abortTurn(): void {
    this.turn?.abort()
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
