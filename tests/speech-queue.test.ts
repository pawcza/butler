import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '../shared/types'
import { createSpeechQueue, SpeechEngineDownError, WARMING_LABEL } from '../server/utils/speech-queue'

interface Call {
  text: string
  voice: string
  signal: AbortSignal
  resolve: (audio: string) => void
  reject: (err: unknown) => void
}

/** A synthesizer whose calls stay pending until the test settles them. Honours abort like fetch. */
function setup(options: { concurrency?: number; signal?: AbortSignal; onGiveUp?: () => void } = {}) {
  const calls: Call[] = []
  const events: ServerEvent[] = []
  const queue = createSpeechQueue<string>({
    synthesize: (text, voice, signal) => new Promise<Buffer>((resolve, reject) => {
      calls.push({ text, voice, signal, resolve: (audio) => resolve(Buffer.from(audio)), reject })
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
    emit: (event) => events.push(event),
    format: 'mp3',
    ...options,
  })
  return { queue, calls, events }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const audio = (events: ServerEvent[]) => events.filter((e) => e.type === 'audio')
const decode = (e: ServerEvent | undefined) => (e?.type === 'audio' ? Buffer.from(e.data, 'base64').toString() : '')

const TWO = 'The first sentence is here. The second sentence follows it.'
const THREE = 'The first sentence is here. The second sentence follows it. The third sentence ends it.'

describe('createSpeechQueue', () => {
  it('speaks a block sentence by sentence, each event saying which characters it reads', async () => {
    const { queue, calls, events } = setup()
    queue.speak('msg.1', TWO, 'voice')
    expect(calls.map((c) => c.text)).toEqual(['The first sentence is here.', 'The second sentence follows it.'])
    calls[0]?.resolve('one')
    calls[1]?.resolve('two')
    await flush()
    const clips = audio(events)
    expect(clips.map(decode)).toEqual(['one', 'two'])
    expect(clips[0]).toMatchObject({ format: 'mp3', block: { id: 'msg.1', start: 0, end: 27 } })
    expect(clips[1]).toMatchObject({ block: { id: 'msg.1', start: 28, end: TWO.length } })
    expect(TWO.slice(28, TWO.length)).toBe(calls[1]?.text)
  })

  it('passes the voice through and sends speech without a block as an event without one', async () => {
    const { queue, calls, events } = setup()
    queue.speak(null, 'Done.', 'pl')
    expect(calls[0]?.voice).toBe('pl')
    calls[0]?.resolve('x')
    await flush()
    expect(audio(events)[0]).not.toHaveProperty('block')
  })

  it('synthesizes ahead of playback, but emits in order even when a later sentence finishes first', async () => {
    const { queue, calls, events } = setup({ concurrency: 2 })
    queue.speak('msg.1', THREE, 'v')
    // two at a time: the third waits for a free slot
    expect(calls).toHaveLength(2)
    calls[1]?.resolve('two')
    await flush()
    expect(audio(events)).toHaveLength(0)
    expect(calls).toHaveLength(3)
    calls[0]?.resolve('one')
    await flush()
    calls[2]?.resolve('three')
    await flush()
    expect(audio(events).map(decode)).toEqual(['one', 'two', 'three'])
  })

  it('keeps blocks in the order they were queued', async () => {
    const { queue, calls, events } = setup({ concurrency: 1 })
    queue.speak('msg.1', 'A long enough first block.', 'v')
    queue.speak('msg.2', 'A long enough second block.', 'v')
    expect(calls).toHaveLength(1)
    calls[0]?.resolve('first')
    await flush()
    calls[1]?.resolve('second')
    await flush()
    expect(audio(events).map((e) => (e.type === 'audio' ? e.block?.id : ''))).toEqual(['msg.1', 'msg.2'])
  })

  it('reports speaking once, and drains when everything is out', async () => {
    const onSpeaking = vi.fn()
    const calls: Array<(b: Buffer) => void> = []
    const queue = createSpeechQueue<string>({
      synthesize: () => new Promise<Buffer>((resolve) => { calls.push(resolve) }),
      emit: vi.fn(),
      format: 'wav',
      onSpeaking,
    })
    await queue.drained()
    expect(onSpeaking).not.toHaveBeenCalled()
    queue.speak('a', 'Just a single sentence of text.', 'v')
    queue.speak('b', 'And another single sentence here.', 'v')
    expect(onSpeaking).toHaveBeenCalledOnce()
    let drained = false
    void queue.drained().then(() => { drained = true })
    for (const resolve of calls) resolve(Buffer.from('x'))
    await flush()
    await flush()
    expect(drained).toBe(true)
  })

  it('reports a failed sentence once and still speaks the next one', async () => {
    const { queue, calls, events } = setup({ concurrency: 1 })
    queue.speak('msg.1', THREE, 'v')
    calls[0]?.reject(new Error('boom'))
    await flush()
    calls[1]?.resolve('two')
    await flush()
    calls[2]?.resolve('three')
    await flush()
    expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'TTS failed: boom' }])
    expect(audio(events).map(decode)).toEqual(['two', 'three'])
  })

  describe('a failing engine', () => {
    const FOUR = `${THREE} The fourth sentence is the last.`

    it('after a connection error drops the rest of the turn at once, with the one error shown', async () => {
      const onGiveUp = vi.fn()
      const { queue, calls, events } = setup({ concurrency: 2, onGiveUp })
      queue.speak('msg.1', FOUR, 'v')
      expect(calls).toHaveLength(2)
      calls[0]?.reject(new SpeechEngineDownError('TTS unreachable: fetch failed (ECONNREFUSED)'))
      await flush()
      expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'TTS failed: TTS unreachable: fetch failed (ECONNREFUSED)' }])
      expect(onGiveUp).toHaveBeenCalledOnce()
      // the request in flight was cancelled, the later sentences are never attempted, and nothing is spoken
      expect(calls[1]?.signal.aborted).toBe(true)
      expect(calls).toHaveLength(2)
      queue.speak('msg.2', 'Another block that arrives later.', 'v')
      await flush()
      expect(calls).toHaveLength(2)
      expect(audio(events)).toHaveLength(0)
      expect(queue.stopped).toBe(true)
      await queue.drained()
    })

    it('after a timeout does the same, even when an earlier sentence was spoken', async () => {
      const { queue, calls, events } = setup({ concurrency: 1 })
      queue.speak('msg.1', FOUR, 'v')
      calls[0]?.resolve('one')
      await flush()
      calls[1]?.reject(new SpeechEngineDownError('TTS request timed out after 60s'))
      await flush()
      expect(audio(events).map(decode)).toEqual(['one'])
      expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
      expect(calls).toHaveLength(2)
    })

    it('after two failures of any kind gives up, showing only the first error', async () => {
      const onGiveUp = vi.fn()
      const { queue, calls, events } = setup({ concurrency: 1, onGiveUp })
      queue.speak('msg.1', FOUR, 'v')
      calls[0]?.reject(new Error('TTS 500: first'))
      await flush()
      expect(onGiveUp).not.toHaveBeenCalled()
      calls[1]?.reject(new Error('TTS 500: second'))
      await flush()
      expect(onGiveUp).toHaveBeenCalledOnce()
      expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'TTS failed: TTS 500: first' }])
      expect(calls).toHaveLength(2)
    })

    it('counts a failure the moment it happens, even behind the head, and the head still plays', async () => {
      const { queue, calls, events } = setup({ concurrency: 2 })
      queue.speak('msg.1', THREE, 'v')
      calls[1]?.reject(new Error('later one'))
      await flush()
      expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'TTS failed: later one' }])
      calls[0]?.resolve('one')
      await flush()
      expect(audio(events).map(decode)).toEqual(['one'])
    })

    it('a dead engine answering behind the head stops further requests at once', async () => {
      const { queue, calls } = setup({ concurrency: 2 })
      queue.speak('msg.1', THREE, 'v')
      calls[1]?.reject(new SpeechEngineDownError('down'))
      await flush()
      expect(queue.stopped).toBe(true)
      expect(calls).toHaveLength(2)
    })

    it('the next turn is a new queue and tries again', async () => {
      const first = setup()
      first.queue.speak('msg.1', TWO, 'v')
      first.calls[0]?.reject(new SpeechEngineDownError('down'))
      await flush()
      expect(first.queue.stopped).toBe(true)
      const second = setup()
      second.queue.speak('msg.1', TWO, 'v')
      expect(second.calls).toHaveLength(2)
      second.calls[0]?.resolve('one')
      await flush()
      expect(audio(second.events).map(decode)).toEqual(['one'])
    })
  })

  describe('markdown and long first sentences', () => {
    it('sends the words to the engine and keeps the ranges on the displayed text', async () => {
      const { queue, calls, events } = setup()
      const text = '**Good** evening, see [the docs](https://example.com/a_b) now. `ls` _lists_ files here.'
      queue.speak('msg.1', text, 'v')
      expect(calls.map((c) => c.text)).toEqual(['Good evening, see the docs now.', 'ls lists files here.'])
      calls[0]?.resolve('x')
      await flush()
      calls[1]?.resolve('y')
      await flush()
      const ends = audio(events).map((e) => (e.type === 'audio' ? e.block : null))
      expect(ends).toEqual([{ id: 'msg.1', start: 0, end: text.indexOf(' `ls`') }, { id: 'msg.1', start: text.indexOf('`ls`'), end: text.length }])
    })

    it('splits only the first sentence of the turn, at a clause boundary near the middle', async () => {
      const { queue, calls } = setup({ concurrency: 4 })
      const long = 'This is the very first sentence of the whole reply, and it keeps going for quite a while longer than anyone would like.'
      queue.speak('msg.1', long, 'v')
      expect(calls.map((c) => c.text)).toEqual([
        'This is the very first sentence of the whole reply,',
        'and it keeps going for quite a while longer than anyone would like.',
      ])
      queue.speak('msg.2', long, 'v')
      expect(calls).toHaveLength(3)
      expect(calls[2]?.text).toBe(long)
    })

    it('drops a sentence that is only markup', async () => {
      const { queue, calls } = setup()
      queue.speak('msg.1', '---', 'v')
      expect(calls).toHaveLength(0)
    })
  })

  describe('stop', () => {
    it('aborts what is in flight, drops what is pending and emits no audio afterwards', async () => {
      const { queue, calls, events } = setup({ concurrency: 2 })
      queue.speak('msg.1', THREE, 'v')
      calls[0]?.resolve('one')
      await flush()
      expect(audio(events)).toHaveLength(1)
      // the second is in flight, the third has been started to fill the slot
      expect(calls).toHaveLength(3)

      queue.stop()
      expect(calls[1]?.signal.aborted).toBe(true)
      expect(calls[2]?.signal.aborted).toBe(true)
      calls[2]?.resolve('late')
      await flush()
      expect(audio(events)).toHaveLength(1)
      await expect(queue.drained()).resolves.toBeUndefined()
    })

    it('never starts the sentences that were still waiting for a slot', async () => {
      const { queue, calls } = setup({ concurrency: 1 })
      queue.speak('msg.1', THREE, 'v')
      expect(calls).toHaveLength(1)
      queue.stop()
      await flush()
      expect(calls).toHaveLength(1)
    })

    it('ignores speech queued after it, and no error is reported for the aborted requests', async () => {
      const { queue, calls, events } = setup()
      queue.speak('msg.1', TWO, 'v')
      queue.stop()
      await flush()
      queue.speak('msg.2', 'A block that arrives after the stop.', 'v')
      expect(calls).toHaveLength(2)
      expect(events).toEqual([])
      expect(queue.stopped).toBe(true)
    })

    it('stops when the turn is aborted', async () => {
      const turn = new AbortController()
      const { queue, calls } = setup({ signal: turn.signal })
      queue.speak('msg.1', TWO, 'v')
      turn.abort()
      expect(calls.every((c) => c.signal.aborted)).toBe(true)
      expect(queue.stopped).toBe(true)
    })
  })

  describe('waiting on a slow speech server', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    const blocks = (events: ServerEvent[]) => events.filter((e) => e.type === 'block_start' || e.type === 'block_end' || e.type === 'block_remove')

    it('shows a tool-style bubble after 2 s and closes it when the audio arrives', async () => {
      const { queue, calls, events } = setup()
      queue.speak('msg.1', 'One sentence that takes a while.', 'v')
      await vi.advanceTimersByTimeAsync(1999)
      expect(blocks(events)).toEqual([])
      await vi.advanceTimersByTimeAsync(2)
      expect(blocks(events)).toEqual([
        { type: 'block_start', blockId: 'speech-warming-1', kind: 'tool_call', tool: WARMING_LABEL },
      ])
      calls[0]?.resolve('audio')
      await vi.advanceTimersByTimeAsync(0)
      expect(events.slice(-2).map((e) => e.type)).toEqual(['block_remove', 'audio'])
      expect(blocks(events).at(-1)).toEqual({ type: 'block_remove', blockId: 'speech-warming-1' })
    })

    it('shows nothing when the audio comes in time', async () => {
      const { queue, calls, events } = setup()
      queue.speak('msg.1', 'One sentence that is quick enough.', 'v')
      await vi.advanceTimersByTimeAsync(1500)
      calls[0]?.resolve('audio')
      await vi.advanceTimersByTimeAsync(5000)
      expect(blocks(events)).toEqual([])
    })

    it('counts the wait of a later sentence from when the one before it was handed over', async () => {
      const { queue, calls, events } = setup()
      queue.speak('msg.1', TWO, 'v')
      await vi.advanceTimersByTimeAsync(1500)
      calls[0]?.resolve('one')
      await vi.advanceTimersByTimeAsync(1000)
      // the second request is 2.5 s old, but only 1 s has passed since the first clip went out
      expect(blocks(events)).toEqual([])
      await vi.advanceTimersByTimeAsync(1100)
      expect(blocks(events)).toHaveLength(1)
    })

    it('closes the bubble when speech is stopped', async () => {
      const { queue, events } = setup()
      queue.speak('msg.1', 'One sentence that takes a while.', 'v')
      await vi.advanceTimersByTimeAsync(2500)
      queue.stop()
      expect(blocks(events).map((e) => e.type)).toEqual(['block_start', 'block_remove'])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(blocks(events)).toHaveLength(2)
    })
  })
})
