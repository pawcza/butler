import type { SessionState } from '~/shared/types'

export class SessionManager {
  private state: SessionState = 'IDLE'
  private readonly onStateChange: (state: SessionState) => void
  private ttsModel: string | null = null
  private ttsVoice: string | null = null

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

  setState(state: SessionState): void {
    this.state = state
    this.onStateChange(state)
  }

  getState(): SessionState {
    return this.state
  }
}
