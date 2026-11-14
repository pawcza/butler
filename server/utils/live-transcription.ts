/** Transcribes 16 kHz mono PCM. Must give up when `signal` fires. */
export type Transcriber = (pcm: Int16Array, signal: AbortSignal) => Promise<string>

export interface LiveTranscriptionOptions {
  transcribe: Transcriber
  /** Text heard so far, from a pass over the whole capture. Never fires after `finish` or `cancel`. */
  onPartial: (text: string) => void
  /** A partial pass failed. Later passes and the final one still run. */
  onPartialError?: (err: unknown) => void
  /** The capture is full and takes no more audio. The owner should `finish` it. */
  onLimit?: () => void
  sampleRate?: number
  /** No partial pass before this much audio has arrived: Whisper makes words up out of a very short clip. */
  minPartialMs?: number
  /** New audio needed before another partial pass. */
  partialStepMs?: number
  /** No partial passes once the capture is longer than this: they'd only get slower. */
  maxPartialMs?: number
  /** Longest capture kept. */
  maxMs?: number
}

interface Pass {
  controller: AbortController
  done: Promise<void>
}

/**
 * One spoken utterance as it arrives. Each time enough new audio is in, and no pass is running,
 * the whole capture so far is transcribed again and reported as a partial. `finish` stops the
 * partials and transcribes everything once more for the final text.
 */
export class LiveTranscription {
  private readonly transcribe: Transcriber
  private readonly onPartial: (text: string) => void
  private readonly onPartialError: ((err: unknown) => void) | undefined
  private readonly onLimit: (() => void) | undefined
  private readonly sampleRate: number
  private readonly minPartialSamples: number
  private readonly stepSamples: number
  private readonly maxPartialSamples: number
  private readonly pcm: Int16Array
  private length = 0
  private lastPassLength = 0
  private pass: Pass | null = null
  private finalPass: AbortController | null = null
  private open = true
  private wasCancelled = false

  constructor(options: LiveTranscriptionOptions) {
    this.transcribe = options.transcribe
    this.onPartial = options.onPartial
    this.onPartialError = options.onPartialError
    this.onLimit = options.onLimit
    this.sampleRate = options.sampleRate ?? 16000
    this.minPartialSamples = Math.round(((options.minPartialMs ?? 1000) * this.sampleRate) / 1000)
    this.stepSamples = Math.round(((options.partialStepMs ?? 500) * this.sampleRate) / 1000)
    this.maxPartialSamples = Math.round(((options.maxPartialMs ?? 30_000) * this.sampleRate) / 1000)
    this.pcm = new Int16Array(Math.round(((options.maxMs ?? 60_000) * this.sampleRate) / 1000))
  }

  get durationMs(): number {
    return Math.round((this.length * 1000) / this.sampleRate)
  }

  get cancelled(): boolean {
    return this.wasCancelled
  }

  push(frame: Int16Array): void {
    if (!this.open || this.length >= this.pcm.length) return
    const take = Math.min(frame.length, this.pcm.length - this.length)
    this.pcm.set(frame.subarray(0, take), this.length)
    this.length += take
    if (this.length >= this.pcm.length) {
      this.onLimit?.()
      return
    }
    this.startPass()
  }

  /** Stops partials, then transcribes the whole capture. Rejects if `cancel` is called meanwhile. */
  async finish(): Promise<string> {
    if (!this.open) throw new Error('capture already closed')
    this.open = false
    const running = this.pass
    if (running) {
      running.controller.abort()
      await running.done
    }
    if (this.wasCancelled) throw new Error('capture cancelled')
    if (this.length === 0) return ''
    this.finalPass = new AbortController()
    try {
      // the audio before `length` is never written again, so a view is a stable snapshot
      return (await this.transcribe(this.pcm.subarray(0, this.length), this.finalPass.signal)).trim()
    } finally {
      this.finalPass = null
    }
  }

  /** Drops the capture and aborts any pass, partial or final. */
  cancel(): void {
    this.open = false
    this.wasCancelled = true
    this.pass?.controller.abort()
    this.finalPass?.abort()
  }

  private startPass(): void {
    if (this.pass || !this.open) return
    if (this.length < this.minPartialSamples) return
    if (this.length - this.lastPassLength < this.stepSamples) return
    if (this.length > this.maxPartialSamples) return
    this.lastPassLength = this.length
    const controller = new AbortController()
    const pass: Pass = { controller, done: Promise.resolve() }
    // set before running, so a transcriber that fails synchronously can't leave a stale pass
    this.pass = pass
    pass.done = this.runPass(this.pcm.subarray(0, this.length), pass)
  }

  private async runPass(pcm: Int16Array, pass: Pass): Promise<void> {
    const { signal } = pass.controller
    try {
      const text = (await this.transcribe(pcm, signal)).trim()
      if (this.open && !signal.aborted && text) this.onPartial(text)
    } catch (err) {
      if (!signal.aborted) this.onPartialError?.(err)
    } finally {
      if (this.pass === pass) this.pass = null
      this.startPass()
    }
  }
}
