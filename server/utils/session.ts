import type { SessionState, Message } from '~/shared/types'

const MAX_MESSAGES = 20

export class SessionManager {
  private state: SessionState = 'IDLE'
  private history: Message[] = []
  private readonly onStateChange: (state: SessionState) => void

  constructor(onStateChange: (state: SessionState) => void) {
    this.onStateChange = onStateChange
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
