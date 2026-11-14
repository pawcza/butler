import { ref, shallowRef } from 'vue'
import { estimateWordTimings, wordIndexAt, type WordTiming } from '~/shared/speech'

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

/** One clip handed to the audio clock: when it starts and ends, and how its words fall. */
interface Scheduled {
  source: AudioBufferSourceNode
  block: SpeechClip['block']
  /** AudioContext time the clip starts and ends. */
  startsAt: number
  endsAt: number
  timings: WordTiming[]
  /** The word last marked, so the highlight only changes when the word does. */
  shown: number
  /** The clip is over: its block is marked spoken. */
  retired: boolean
}

/** A clip waiting its turn, already being decoded. */
interface Pending {
  clip: SpeechClip
  decoded: Promise<AudioBuffer | null>
}

/**
 * Plays the server's clips one after another, and can pause, resume and stop them. Clips are
 * decoded as soon as they arrive and scheduled on the AudioContext clock, each starting where the
 * one before it ends, so a clip that is ready in time follows the last one with no gap, however slow
 * the device is at running timers and events. While they play it follows the words: no engine here
 * reports word times, so they are estimated from the clip's decoded length (see `estimateWordTimings`).
 */
export function createSpeechPlayer(options: SpeechPlayerOptions) {
  let ctx: AudioContext | null = null
  let gain: GainNode | null = null
  let analyser: AnalyserNode | null = null
  let bins = new Uint8Array(0)
  const queue: Pending[] = []
  /** Clips on the audio clock, in order: playing now or waiting for their time. */
  let scheduled: Scheduled[] = []
  /** AudioContext time at which the last scheduled clip ends. */
  let scheduledEnd = 0
  /** Bumped by `stop`, so a loop that is still waiting on a clip knows it has been cut off. */
  let generation = 0
  /** The loop that decodes and schedules is running. */
  let scheduling = false
  /** After a stop, clips already on their way from the server are ignored until `accept`. */
  let refusing = false
  /**
   * The browser keeps the context suspended (autoplay policy, no user gesture yet): the queue waits
   * for a gesture, and meanwhile the player is not `active`, so the client follows the server's state.
   */
  let blocked = false
  /** Releases the wait for a gesture. */
  let releaseGesture: (() => void) | null = null
  let frame = 0

  /** Clips are playing, paused or waiting. */
  const active = ref(false)
  const paused = ref(false)
  const progress = shallowRef<SpeechProgress | null>(null)

  function output(audio: AudioContext): AnalyserNode {
    if (!gain || !analyser || gain.context !== audio) {
      gain = audio.createGain()
      gain.connect(audio.destination)
      // source → analyser → gain → destination
      // The analyser sits before the gain so the visualisation doesn't depend on the volume.
      analyser = audio.createAnalyser()
      analyser.fftSize = 256
      analyser.connect(gain)
      bins = new Uint8Array(analyser.frequencyBinCount)
    }
    gain.gain.value = options.volume()
    return analyser
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

  /** The clip is over: its sentence counts as read. */
  function retire(item: Scheduled): void {
    if (item.retired) return
    item.retired = true
    if (item.block) markSpoken(item.block.id, item.block.end)
  }

  /** Every frame while clips are scheduled: the loudness, and the word the audio clock is at. */
  function tick(): void {
    if (!ctx || !analyser || scheduled.length === 0) return
    analyser.getByteFrequencyData(bins)
    let sum = 0
    for (const v of bins) sum += v * v
    options.onEnergy(Math.sqrt(sum / bins.length) / 128)

    // a suspended context stops its clock, so a pause holds the word too
    const now = ctx.currentTime
    const playing = scheduled.find((item) => now < item.endsAt)
    for (const item of scheduled) {
      if (item === playing) break
      retire(item)
    }
    if (playing && playing.block && playing.timings.length > 0 && now >= playing.startsAt) {
      const index = wordIndexAt(playing.timings, now - playing.startsAt)
      const word = playing.timings[index]
      if (index !== playing.shown && word) {
        playing.shown = index
        markWord(playing.block.id, word.start, word.end)
      }
    }
    frame = requestAnimationFrame(tick)
  }

  /** Nothing is playing, scheduled or waiting: the queue ran dry. */
  function finishIfDry(gen: number): void {
    if (gen !== generation || scheduling || queue.length > 0 || scheduled.length > 0) return
    cancelAnimationFrame(frame)
    active.value = false
    options.onEnergy(0)
    options.onIdle()
  }

  /** Puts a decoded clip on the audio clock, right after the one before it. */
  function schedule(audio: AudioContext, clip: SpeechClip, decoded: AudioBuffer, gen: number): void {
    const source = audio.createBufferSource()
    source.buffer = decoded
    source.connect(output(audio))

    const text = clip.block ? options.textOf(clip.block.id) : undefined
    const timings = clip.block && text !== undefined ? estimateWordTimings(text, clip.block, decoded.duration) : []
    // a clip that arrives late starts now; one that arrives in time starts exactly where the last ends
    const startsAt = Math.max(scheduledEnd, audio.currentTime)
    const item: Scheduled = { source, block: clip.block, startsAt, endsAt: startsAt + decoded.duration, timings, shown: -2, retired: false }
    scheduledEnd = item.endsAt
    if (scheduled.length === 0) {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
    scheduled.push(item)
    source.onended = () => {
      if (gen !== generation) return
      retire(item)
      scheduled = scheduled.filter((other) => other !== item)
      finishIfDry(gen)
    }
    source.start(startsAt)
  }

  /** Decodes clips as they arrive, in parallel, and schedules them in order. */
  async function run(): Promise<void> {
    scheduling = true
    const gen = generation
    while (gen === generation) {
      const next = queue.shift()
      if (!next) break
      const decoded = await next.decoded
      if (gen !== generation) return
      if (!decoded || !ctx) continue
      if (!(await ready(ctx, gen))) return
      try {
        schedule(ctx, next.clip, decoded, gen)
      } catch {
        // a clip that can't be played is skipped
      }
    }
    // a stop took over: it has reset everything already
    if (gen !== generation) return
    scheduling = false
    finishIfDry(gen)
  }

  function decode(clip: SpeechClip): Promise<AudioBuffer | null> {
    try {
      ctx ??= new AudioContext()
      return ctx.decodeAudioData(decodeBase64(clip.data)).catch(() => null)
    } catch {
      return Promise.resolve(null)
    }
  }

  return {
    active,
    paused,
    progress,

    /** Queues a clip, unless speech was stopped and the next turn hasn't begun. */
    enqueue(clip: SpeechClip): void {
      if (refusing) return
      queue.push({ clip, decoded: decode(clip) })
      if (!blocked) active.value = true
      if (!scheduling) void run()
    },

    /** Silences everything now and drops the queue. Later clips are ignored until `accept`. */
    stop(): void {
      refusing = true
      generation += 1
      scheduling = false
      queue.length = 0
      blocked = false
      releaseGesture?.()
      const playing = scheduled
      scheduled = []
      scheduledEnd = 0
      for (const item of playing) {
        item.source.onended = null
        try { item.source.stop() } catch { /* already ended */ }
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
