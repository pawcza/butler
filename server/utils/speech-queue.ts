import type { ServerEvent } from '~/shared/types'
import { splitSentences } from '~/shared/speech'

/** The label of the activity bubble shown while the speech server is slow to answer. */
export const WARMING_LABEL = 'Warming up the speech model'

export interface SpeechQueueOptions<Voice> {
  /** Turns one sentence into audio in `voice`. Must give up when `signal` fires. */
  synthesize: (text: string, voice: Voice, signal: AbortSignal) => Promise<Buffer>
  emit: (event: ServerEvent) => void
  format: 'mp3' | 'wav'
  /** Fires the first time something is queued, so the session can show it is speaking. */
  onSpeaking?: () => void
  /** Aborts all speech, like `stop`. */
  signal?: AbortSignal
  /** Sentences synthesized at once. Audio is still emitted in order. */
  concurrency?: number
  /** How long the next sentence may wait before the warming bubble shows. */
  warmingAfterMs?: number
}

interface Job<Voice> {
  text: string
  voice: Voice
  block: { id: string; start: number; end: number } | null
  /** When the request went out. */
  startedAt: number | null
  result: { audio: Buffer } | { error: unknown } | null
}

/**
 * The speech of one turn. Message blocks are split into sentences, synthesized a couple at a time
 * and emitted as `audio` events strictly in order, each saying which characters it speaks.
 * `stop` drops everything pending and aborts what is in flight: no audio event follows it.
 */
export function createSpeechQueue<Voice>(options: SpeechQueueOptions<Voice>) {
  const concurrency = options.concurrency ?? 2
  const warmingAfterMs = options.warmingAfterMs ?? 2000
  const stopper = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, stopper.signal]) : stopper.signal
  const jobs: Job<Voice>[] = []
  const waiters: Array<() => void> = []
  let running = 0
  let spoke = false
  let failureReported = false
  let lastEmitAt: number | null = null
  let warmTimer: ReturnType<typeof setTimeout> | null = null
  let warmBlock: string | null = null
  let warmCount = 0

  const stopped = (): boolean => signal.aborted

  function closeWarming(): void {
    if (warmBlock === null) return
    options.emit({ type: 'block_end', blockId: warmBlock, text: '' })
    warmBlock = null
  }

  function clearTimer(): void {
    if (warmTimer !== null) clearTimeout(warmTimer)
    warmTimer = null
  }

  /** Shows the warming bubble once the sentence next to play has waited too long for the server. */
  function watchHead(): void {
    clearTimer()
    const head = jobs[0]
    if (!head || head.result || head.startedAt === null || stopped()) return
    // The wait counts from when the sentence before it was handed over, if that was later than its request.
    const since = Math.max(head.startedAt, lastEmitAt ?? 0)
    warmTimer = setTimeout(() => {
      warmTimer = null
      if (stopped() || jobs[0] !== head || head.result || warmBlock !== null) return
      warmCount += 1
      warmBlock = `speech-warming-${warmCount}`
      options.emit({ type: 'block_start', blockId: warmBlock, kind: 'tool_call', tool: WARMING_LABEL })
    }, Math.max(0, since + warmingAfterMs - Date.now()))
  }

  function settle(): void {
    if (jobs.length === 0) for (const done of waiters.splice(0)) done()
  }

  /** Emits every finished sentence at the head of the line. */
  function flush(): void {
    while (!stopped()) {
      const head = jobs[0]
      if (!head?.result) break
      jobs.shift()
      closeWarming()
      if ('audio' in head.result) {
        lastEmitAt = Date.now()
        options.emit({
          type: 'audio',
          data: head.result.audio.toString('base64'),
          format: options.format,
          ...(head.block ? { block: head.block } : {}),
        })
      } else if (!failureReported) {
        failureReported = true
        const err = head.result.error
        options.emit({ type: 'error', message: `TTS failed: ${err instanceof Error ? err.message : err}` })
      }
    }
    watchHead()
    settle()
  }

  function pump(): void {
    for (const job of jobs) {
      if (running >= concurrency || stopped()) return
      if (job.startedAt !== null) continue
      job.startedAt = Date.now()
      running += 1
      options.synthesize(job.text, job.voice, signal).then(
        (audio) => { job.result = { audio } },
        (error: unknown) => { job.result = { error } },
      ).finally(() => {
        running -= 1
        if (stopped()) return
        flush()
        pump()
      })
    }
    watchHead()
  }

  signal.addEventListener('abort', () => {
    jobs.length = 0
    clearTimer()
    closeWarming()
    settle()
  }, { once: true })

  return {
    /**
     * Queues a message block for speech. `voice` is passed through to `synthesize`. A block of text
     * belongs to `blockId`; speech with no block (a fallback line) has `null` and no highlight.
     */
    speak(blockId: string | null, text: string, voice: Voice): void {
      if (stopped()) return
      for (const range of splitSentences(text)) {
        jobs.push({
          text: text.slice(range.start, range.end),
          voice,
          block: blockId !== null ? { id: blockId, ...range } : null,
          startedAt: null,
          result: null,
        })
      }
      if (jobs.length > 0 && !spoke) {
        spoke = true
        options.onSpeaking?.()
      }
      pump()
    },
    /** Drops pending sentences, aborts the ones in flight and closes the warming bubble. */
    stop: (): void => stopper.abort(),
    get stopped(): boolean {
      return stopped()
    },
    /** Resolves once everything queued is emitted, failed or dropped. */
    drained(): Promise<void> {
      if (jobs.length === 0) return Promise.resolve()
      return new Promise((resolve) => { waiters.push(resolve) })
    },
  }
}

export type SpeechQueue<Voice> = ReturnType<typeof createSpeechQueue<Voice>>
