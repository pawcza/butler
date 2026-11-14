import { ref, shallowRef } from 'vue'
import { estimateWordTimings, wordIndexAt } from '~/shared/speech'

/** One spoken sentence from the server. `block` says what it reads, for the highlight. */
export interface SpeechClip {
  data: string
  format: 'mp3' | 'wav'
  block?: { id: string; start: number; end: number }
}

/**
 * How far speech has got, per message block. Text before `spoken[blockId]` is read already; `word` is the
 * one being read now.
 */
export interface SpeechProgress {
  spoken: Record<string, number>
  word: { blockId: string; start: number; end: number } | null
}

export interface SpeechPlayerOptions {
  /** The full text of a message block, to estimate where its words fall in a clip. */
  textOf: (blockId: string) => string | undefined
  /** The output level, 0 to 1. */
  volume: () => number
  /** Loudness of what plays, 0 to 1, about every frame: it drives the avatar. */
  onEnergy: (energy: number) => void
  /** The queue ran dry: nothing is playing or waiting. Not called by `stop`. */
  onIdle: () => void
}

/** How long a fresh `resume()` gets to bring the context up before it counts as blocked by the browser. */
const RESUME_WAIT_MS = 150

// a function, so TypeScript doesn't narrow `state` across the awaits that change it
const isRunning = (audio: AudioContext): boolean => audio.state === 'running'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/**
 * Plays the server's clips one after another, and can pause, resume and stop them. While a clip plays
 * it follows the words: no engine here reports word times, so they are estimated from the clip's
 * decoded length (see `estimateWordTimings`).
 */
export function createSpeechPlayer(options: SpeechPlayerOptions) {
  let ctx: AudioContext | null = null
  let gain: GainNode | null = null
  const queue: SpeechClip[] = []
  /** Bumped by `stop`, so a loop that is still waiting on a clip knows it has been cut off. */
  let generation = 0
  let running = false
  /** After a stop, clips already on their way from the server are ignored until `accept`. */
  let refusing = false
  /**
   * The browser keeps the context suspended (autoplay policy, no user gesture yet): the queue waits
   * for a gesture, and meanwhile the player is not `active`, so the client follows the server's state.
   */
  let blocked = false
  /** Releases the wait for a gesture. */
  let releaseGesture: (() => void) | null = null
  let current: { source: AudioBufferSourceNode; finish: () => void } | null = null
  let frame = 0

  /** Clips are playing, paused or waiting. */
  const active = ref(false)
  const paused = ref(false)
  const progress = shallowRef<SpeechProgress | null>(null)

  function output(audio: AudioContext): GainNode {
    if (!gain || gain.context !== audio) {
      gain = audio.createGain()
      gain.connect(audio.destination)
    }
    gain.gain.value = options.volume()
    return gain
  }

  function markWord(blockId: string, start: number, end: number): void {
    const spoken = { ...progress.value?.spoken, [blockId]: start }
    progress.value = { spoken, word: { blockId, start, end } }
  }

  function markSpoken(blockId: string, end: number): void {
    const spoken = { ...progress.value?.spoken, [blockId]: end }
    progress.value = { spoken, word: null }
  }

  /** Resolves on the next pointer or key press, or when `stop` calls `releaseGesture`. */
  function waitForGesture(audio: AudioContext): Promise<void> {
    return new Promise<void>((resolve) => {
      const events = ['pointerdown', 'keydown'] as const
      const done = (): void => {
        for (const name of events) window.removeEventListener(name, onGesture, true)
        releaseGesture = null
        resolve()
      }
      // resume inside the handler itself: that is what the autoplay policy accepts
      const onGesture = (): void => {
        if (!paused.value) void audio.resume().catch(() => {})
        done()
      }
      for (const name of events) window.addEventListener(name, onGesture, true)
      releaseGesture = done
    })
  }

  /**
   * Waits until `audio` can play. A context the user paused is left alone: `resume` brings it back.
   * One the browser holds suspended is retried on each user gesture, and while it waits the player
   * is not active. Resolves to false when `stop` cut the wait off.
   */
  async function ready(audio: AudioContext, gen: number): Promise<boolean> {
    for (;;) {
      if (gen !== generation) return false
      if (paused.value || isRunning(audio)) return true
      await Promise.race([audio.resume().catch(() => {}), sleep(RESUME_WAIT_MS)])
      if (gen !== generation) return false
      if (paused.value || isRunning(audio)) return true
      blocked = true
      active.value = false
      options.onEnergy(0)
      options.onIdle()
      await waitForGesture(audio)
      blocked = false
      if (gen !== generation) return false
      active.value = true
    }
  }

  function playClip(clip: SpeechClip, gen: number): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        ctx ??= new AudioContext()
        const audio = ctx
        audio.decodeAudioData(decodeBase64(clip.data)).then(async (decoded) => {
          if (gen !== generation || !(await ready(audio, gen))) { resolve(); return }
          const source = audio.createBufferSource()
          source.buffer = decoded

          // source → analyser → gain → destination
          // The analyser sits before the gain so the visualisation doesn't depend on the volume.
          const analyser = audio.createAnalyser()
          analyser.fftSize = 256
          source.connect(analyser)
          analyser.connect(output(audio))

          const { block } = clip
          const text = block ? options.textOf(block.id) : undefined
          const timings = block && text !== undefined ? estimateWordTimings(text, block, decoded.duration) : []
          const startedAt = audio.currentTime
          let shown = -2
          const bins = new Uint8Array(analyser.frequencyBinCount)
          const tick = (): void => {
            analyser.getByteFrequencyData(bins)
            let sum = 0
            for (const v of bins) sum += v * v
            options.onEnergy(Math.sqrt(sum / bins.length) / 128)
            if (block && timings.length > 0) {
              // a suspended context stops its clock, so a pause holds the word too
              const index = wordIndexAt(timings, audio.currentTime - startedAt)
              const word = timings[index]
              if (index !== shown && word) {
                shown = index
                markWord(block.id, word.start, word.end)
              }
            }
            frame = requestAnimationFrame(tick)
          }
          tick()

          const finish = (): void => {
            cancelAnimationFrame(frame)
            current = null
            resolve()
          }
          current = { source, finish }
          source.onended = () => {
            if (block) markSpoken(block.id, block.end)
            finish()
          }
          source.start()
        }).catch(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  async function run(): Promise<void> {
    running = true
    const gen = generation
    while (gen === generation) {
      const clip = queue.shift()
      if (!clip) break
      await playClip(clip, gen)
    }
    // a stop took over: it has reset everything already
    if (gen !== generation) return
    running = false
    active.value = false
    options.onEnergy(0)
    options.onIdle()
  }

  return {
    active,
    paused,
    progress,

    /** Queues a clip, unless speech was stopped and the next turn hasn't begun. */
    enqueue(clip: SpeechClip): void {
      if (refusing) return
      queue.push(clip)
      if (!blocked) active.value = true
      if (!running) void run()
    },

    /** Silences everything now and drops the queue. Later clips are ignored until `accept`. */
    stop(): void {
      refusing = true
      generation += 1
      running = false
      queue.length = 0
      blocked = false
      releaseGesture?.()
      const playing = current
      current = null
      if (playing) {
        playing.source.onended = null
        try { playing.source.stop() } catch { /* already ended */ }
        playing.finish()
      }
      cancelAnimationFrame(frame)
      options.onEnergy(0)
      if (paused.value) {
        paused.value = false
        void ctx?.resume()
      }
      active.value = false
      progress.value = null
    },

    /** A new turn begins: its clips are welcome again. */
    accept(): void {
      refusing = false
    },

    pause(): void {
      if (!active.value || paused.value) return
      paused.value = true
      void ctx?.suspend()
    },

    resume(): void {
      if (!paused.value) return
      paused.value = false
      void ctx?.resume()
    },

    /** Removes the highlight, once speech is over. */
    clearProgress(): void {
      progress.value = null
    },

    /** The volume setting changed. */
    applyVolume(): void {
      if (gain) gain.gain.value = options.volume()
    },
  }
}

export type SpeechPlayer = ReturnType<typeof createSpeechPlayer>
