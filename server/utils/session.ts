import type { SessionState } from '~/shared/types'

/** One turn: the model's reply and its speech. Its signal fires if the client goes away mid-response. */
export interface Turn {
  id: number
  signal: AbortSignal
}

export class SessionManager {
  private state: SessionState = 'IDLE'
  private readonly onStateChange: (state: SessionState) => void
  /** Thread id; null until the first message opens one, so every session starts clean. */
  private conversationId: string | null = null
  private turn: AbortController | null = null
  private turnId = 0
  private stopSpeechOfTurn: (() => void) | null = null
  /** The model has finished: only the speech is left of the turn. */
  private speechOnly = false
  private closed = false
  private readonly closeHooks = new Set<() => void>()
  /** The signed-in user's OIDC `sub`, or null when login is off. An opaque id, never a name or email. */
  private readonly userId: string | null

  constructor(onStateChange: (state: SessionState) => void, userId?: string) {
    this.onStateChange = onStateChange
    this.userId = userId ?? null
  }

  getUserId(): string | null {
    return this.userId
  }

  getConversationId(): string | null {
    return this.conversationId
  }

  setConversationId(id: string | null): void {
    this.conversationId = id
  }

  /** The socket is gone: nothing may start a turn for it any more. */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * The socket closed. Aborts the running turn, runs what was registered with `onClose`, and from
   * now on every turn begins already aborted.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.turn?.abort()
    for (const hook of [...this.closeHooks]) hook()
    this.closeHooks.clear()
  }

  /** Runs `hook` when the session closes, at once if it already has. Returns a way to unregister it. */
  onClose(hook: () => void): () => void {
    if (this.closed) {
      hook()
      return () => {}
    }
    this.closeHooks.add(hook)
    return () => { this.closeHooks.delete(hook) }
  }

  beginTurn(): Turn {
    this.turn = new AbortController()
    if (this.closed) this.turn.abort()
    this.turnId += 1
    this.stopSpeechOfTurn = null
    this.speechOnly = false
    return { id: this.turnId, signal: this.turn.signal }
  }

  abortTurn(): void {
    this.turn?.abort()
  }

  /** Registers how to silence the running turn's speech. */
  onStopSpeech(stop: () => void): void {
    this.stopSpeechOfTurn = stop
  }

  /** The model is done with the running turn, so what is left of it is speech. */
  markSpeechOnly(): void {
    this.speechOnly = true
  }

  /**
   * Drops the rest of the running turn's speech. The turn itself carries on: its reply text keeps
   * streaming, and it ends the usual way. While the model is still working, the session is no
   * longer speaking.
   */
  stopSpeech(): void {
    this.stopSpeechOfTurn?.()
    if (this.state === 'SPEAKING' && !this.speechOnly) this.setState('THINKING')
  }

  /** A new capture may open when idle, or when only speech is left of the turn (barge-in). */
  canCapture(): boolean {
    return this.state === 'IDLE' || (this.state === 'SPEAKING' && this.speechOnly)
  }

  /** Ends the speech-only rest of a turn right now, so a new capture can take over. */
  supersedeTurn(): void {
    this.stopSpeechOfTurn?.()
    this.turnId += 1
    this.speechOnly = false
    this.setState('IDLE')
  }

  /** The turn is over. A turn that was superseded in the meantime leaves the session alone. */
  finishTurn(id: number): void {
    if (id !== this.turnId) return
    this.speechOnly = false
    this.setState('IDLE')
  }

  setState(state: SessionState): void {
    this.state = state
    this.onStateChange(state)
  }

  getState(): SessionState {
    return this.state
  }
}
