import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechClip, SpeechPlayerOptions } from '../utils/speech-player'

// `vue` is Nuxt's, not a dependency of its own, so the tests have no copy to load: the player
// only needs `.value` on its refs.
vi.mock('vue', () => ({
  ref: <T>(value: T) => ({ value }),
  shallowRef: <T>(value: T) => ({ value }),
}))

const { createSpeechPlayer } = await import('../utils/speech-player')

/** A clip whose decoded length is `seconds`: the fake decoder reads it back from the data. */
const clip = (seconds: number, block?: SpeechClip['block']): SpeechClip => ({
  data: btoa(String(seconds)),
  format: 'wav',
  ...(block ? { block } : {}),
})

class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  startedAt: number | null = null
  stopped = false
  connect(): void {}
  start(when = 0): void { this.startedAt = when }
  stop(): void { this.stopped = true }
}

class FakeContext {
  static instances: FakeContext[] = []
  currentTime = 0
  state: 'running' | 'suspended' = 'running'
  /** When set, `resume()` stays pending until the test calls it, like a browser waiting for a gesture. */
  gated = false
  resumeNow: (() => void) | null = null
  sources: FakeSource[] = []
  destination = {}
  constructor() { FakeContext.instances.push(this) }
  decodeAudioData(data: ArrayBuffer): Promise<{ duration: number }> {
    return Promise.resolve({ duration: Number(new TextDecoder().decode(data)) })
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
  createGain() { return { context: this, gain: { value: 1 }, connect() {} } }
  createAnalyser() {
    return { fftSize: 0, frequencyBinCount: 4, connect() {}, getByteFrequencyData(bins: Uint8Array) { bins.fill(0) } }
  }
  suspend(): Promise<void> { this.state = 'suspended'; return Promise.resolve() }
  resume(): Promise<void> {
    if (!this.gated) { this.state = 'running'; return Promise.resolve() }
    return new Promise((resolve) => { this.resumeNow = () => { this.state = 'running'; resolve() } })
  }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }

let frames: Array<() => void> = []
const runFrame = (): void => { const callbacks = frames; frames = []; callbacks.forEach((f) => f()) }
let gestures: Array<() => void> = []

beforeEach(() => {
  FakeContext.instances = []
  frames = []
  gestures = []
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => frames.push(f))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('window', {
    addEventListener: (_name: string, f: () => void) => gestures.push(f),
    removeEventListener: () => {},
  })
})
afterEach(() => { vi.unstubAllGlobals() })

function setup(textOf: SpeechPlayerOptions['textOf'] = () => undefined) {
  const onIdle = vi.fn()
  const onEnergy = vi.fn()
  const player = createSpeechPlayer({ textOf, volume: () => 1, onEnergy, onIdle })
  const ctx = (): FakeContext => FakeContext.instances[0] as FakeContext
  return { player, onIdle, onEnergy, ctx }
}

describe('speech player scheduling', () => {
  it('starts each clip on the audio clock where the one before it ends, without waiting for it to finish', async () => {
    const { player, ctx } = setup()
    player.enqueue(clip(2))
    player.enqueue(clip(3))
    player.enqueue(clip(1))
    await settle()
    const starts = ctx().sources.map((s) => s.startedAt)
    // all three are on the clock at once: 0 to 2, 2 to 5, 5 to 6, with no gap to depend on events
    expect(starts).toEqual([0, 2, 5])
    expect(player.active.value).toBe(true)
  })

  it('a clip that arrives late starts now, and the next one follows it exactly', async () => {
    const { player, ctx } = setup()
    player.enqueue(clip(2))
    await settle()
    ctx().currentTime = 7
    ctx().sources[0]?.onended?.()
    player.enqueue(clip(1))
    await settle()
    player.enqueue(clip(1))
    await settle()
    expect(ctx().sources.map((s) => s.startedAt)).toEqual([0, 7, 8])
  })

  it('is idle only once the last clip has ended', async () => {
    const { player, onIdle, ctx } = setup()
    player.enqueue(clip(1))
    player.enqueue(clip(1))
    await settle()
    ctx().sources[0]?.onended?.()
    expect(onIdle).not.toHaveBeenCalled()
    expect(player.active.value).toBe(true)
    ctx().sources[1]?.onended?.()
    expect(onIdle).toHaveBeenCalledOnce()
    expect(player.active.value).toBe(false)
  })

  it('follows the words by the scheduled start, and marks a clip read when the clock passes its end', async () => {
    const text = 'one two three four'
    const { player, ctx } = setup(() => text)
    player.enqueue(clip(4, { id: 'b', start: 0, end: 7 }))
    player.enqueue(clip(4, { id: 'b', start: 8, end: text.length }))
    await settle()
    runFrame()
    expect(player.progress.value?.word).toEqual({ blockId: 'b', start: 0, end: 3 })
    // the first clip is half over: its second word; the second clip hasn't started
    ctx().currentTime = 2.5
    runFrame()
    expect(player.progress.value?.word).toEqual({ blockId: 'b', start: 4, end: 7 })
    // the clock crosses into the second clip before any ended event arrives: its first word, the first clip read
    ctx().currentTime = 4.2
    runFrame()
    expect(player.progress.value?.word).toEqual({ blockId: 'b', start: 8, end: 13 })
    expect(player.progress.value?.spoken['b']).toBe(8)
    // a late ended event of the first clip doesn't wipe the word of the second
    ctx().sources[0]?.onended?.()
    expect(player.progress.value?.word).toEqual({ blockId: 'b', start: 8, end: 13 })
  })

  it('pause suspends the clock, so scheduled clips and the highlight hold; resume brings them back', async () => {
    const text = 'one two three four'
    const { player, ctx } = setup(() => text)
    player.enqueue(clip(4, { id: 'b', start: 0, end: text.length }))
    await settle()
    ctx().currentTime = 1
    player.pause()
    expect(player.paused.value).toBe(true)
    expect(ctx().state).toBe('suspended')
    // a clip arriving while paused is still scheduled, and plays when the clock runs again
    player.enqueue(clip(2))
    await settle()
    expect(ctx().sources.map((s) => s.startedAt)).toEqual([0, 4])
    player.resume()
    expect(ctx().state).toBe('running')
  })

  it('stop silences everything scheduled, drops the queue, and refuses clips until the next turn', async () => {
    const { player, onIdle, ctx } = setup()
    player.enqueue(clip(2))
    player.enqueue(clip(2))
    await settle()
    player.stop()
    expect(ctx().sources.every((s) => s.stopped)).toBe(true)
    expect(ctx().sources.every((s) => s.onended === null)).toBe(true)
    expect(player.active.value).toBe(false)
    expect(player.progress.value).toBeNull()
    expect(onIdle).not.toHaveBeenCalled()
    player.enqueue(clip(1))
    await settle()
    expect(ctx().sources).toHaveLength(2)
    player.accept()
    player.enqueue(clip(1))
    await settle()
    // the clock restarts from the context's time, not from the stopped clips
    expect(ctx().sources.at(-1)?.startedAt).toBe(0)
    expect(ctx().sources).toHaveLength(3)
  })

  it('stop while clips are still decoding schedules none of them', async () => {
    const { player, ctx } = setup()
    player.enqueue(clip(2))
    player.enqueue(clip(2))
    player.stop()
    await settle()
    expect(ctx().sources).toHaveLength(0)
  })

  it('a context the browser holds suspended parks the queue until a gesture, then plays all of it in order', async () => {
    const { player, onIdle, ctx } = setup()
    player.enqueue(clip(1))
    ctx().state = 'suspended'
    ctx().gated = true
    player.enqueue(clip(2))
    player.enqueue(clip(3))
    await new Promise((r) => setTimeout(r, 250))
    expect(ctx().sources).toHaveLength(0)
    expect(player.active.value).toBe(false)
    expect(onIdle).toHaveBeenCalled()
    expect(gestures.length).toBeGreaterThan(0)
    gestures.forEach((f) => f())
    ctx().resumeNow?.()
    await settle()
    expect(player.active.value).toBe(true)
    expect(ctx().sources.map((s) => s.startedAt)).toEqual([0, 1, 3])
  })
})
