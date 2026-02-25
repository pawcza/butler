import type { SessionState, Message, Personality } from '~/shared/types'

const MAX_MESSAGES = 10

export class SessionManager {
  private state: SessionState = 'IDLE'
  private history: Message[] = []
  private readonly onStateChange: (state: SessionState) => void
  private ttsModel: string | null = null
  private ttsVoice: string | null = null
  private personality: Personality = 'glados'

  constructor(onStateChange: (state: SessionState) => void) {
    this.onStateChange = onStateChange
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

  setPersonality(p: Personality): void {
    this.personality = p
  }

  getPersonality(): Personality {
    return this.personality
  }

  setState(state: SessionState): void {
    this.state = state
    this.onStateChange(state)
  }

  getState(): SessionState {
    return this.state
  }

  addMessage(message: Message): void {
    this.history.push(message)
    if (this.history.length > MAX_MESSAGES) {
      this.history = this.history.slice(this.history.length - MAX_MESSAGES)
    }
  }

  getHistory(): Message[] {
    return [...this.history]
  }

  clearHistory(): void {
    this.history = []
  }
}
