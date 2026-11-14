import { describe, expect, it, vi } from 'vitest'
import { LiveTranscription, type Transcriber } from '../server/utils/live-transcription'

const RATE = 16000
/** Audio of `ms` milliseconds. */
const audio = (ms: number) => new Int16Array((RATE * ms) / 1000)

interface Call {
  samples: number
  signal: AbortSignal
  resolve: (text: string) => void
  reject: (err: unknown) => void
}

/** A transcriber whose calls stay pending until the test settles them. Honours abort like fetch. */
function controlledTranscriber() {
  const calls: Call[] = []
  const transcribe: Transcriber = (pcm, signal) => new Promise<string>((resolve, reject) => {
    calls.push({ samples: pcm.length, signal, resolve, reject })
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
  return { calls, transcribe }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('LiveTranscription', () => {
  it('makes no partial pass before a second of audio, then goes on in half-second steps', async () => {
    const { calls, transcribe } = controlledTranscriber()
    const live = new LiveTranscription({ transcribe, onPartial: vi.fn() })
    live.push(audio(500))
    live.push(audio(400))
    expect(calls).toHaveLength(0)
    live.push(audio(100))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.samples).toBe(RATE)
    calls[0]?.resolve('a')
    await flush()
    live.push(audio(400))
    expect(calls).toHaveLength(1)
    live.push(audio(100))
    expect(calls).toHaveLength(2)
    expect(calls[1]?.samples).toBe(RATE * 1.5)
  })

  it('starts a partial pass once half a second has arrived, over the whole capture', () => {
    const { calls, transcribe } = controlledTranscriber()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial: vi.fn() })
    live.push(audio(300))
    expect(calls).toHaveLength(0)
    live.push(audio(200))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.samples).toBe(RATE / 2)
  })

  it('runs one pass at a time, and catches up on the audio that came in meanwhile', async () => {
    const { calls, transcribe } = controlledTranscriber()
    const onPartial = vi.fn()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial })
    live.push(audio(500))
    live.push(audio(500))
    live.push(audio(500))
    expect(calls).toHaveLength(1)

    calls[0]?.resolve(' hello ')
    await flush()
    expect(onPartial).toHaveBeenCalledWith('hello')
    // the second pass covers everything so far, not just the new part
    expect(calls).toHaveLength(2)
    expect(calls[1]?.samples).toBe(RATE * 1.5)

    calls[1]?.resolve('hello there')
    await flush()
    expect(onPartial.mock.calls.map((c) => c[0])).toEqual(['hello', 'hello there'])
    // nothing new since, so no third pass
    expect(calls).toHaveLength(2)
  })

  it('waits for another half second after a pass before the next one', async () => {
    const { calls, transcribe } = controlledTranscriber()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial: vi.fn() })
    live.push(audio(500))
    calls[0]?.resolve('a')
    await flush()
    live.push(audio(400))
    expect(calls).toHaveLength(1)
    live.push(audio(100))
    expect(calls).toHaveLength(2)
  })

  it('skips empty partials and keeps going after a failed one', async () => {
    const { calls, transcribe } = controlledTranscriber()
    const onPartial = vi.fn()
    const onPartialError = vi.fn()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial, onPartialError })
    live.push(audio(500))
    calls[0]?.resolve('   ')
    await flush()
    live.push(audio(500))
    calls[1]?.reject(new Error('busy'))
    await flush()
    live.push(audio(500))
    calls[2]?.resolve('ok')
    await flush()
    expect(onPartial.mock.calls).toEqual([['ok']])
    expect(onPartialError).toHaveBeenCalledOnce()
  })

  it('stops partial passes past the partial limit', () => {
    const { calls, transcribe } = controlledTranscriber()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial: vi.fn(), maxPartialMs: 1000 })
    live.push(audio(1500))
    expect(calls).toHaveLength(0)
  })

  it('on finish aborts the running partial, never reports it, and transcribes everything', async () => {
    const { calls, transcribe } = controlledTranscriber()
    const onPartial = vi.fn()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial })
    live.push(audio(500))
    live.push(audio(700))

    const final = live.finish()
    expect(calls[0]?.signal.aborted).toBe(true)
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.samples).toBe(RATE * 1.2)
    calls[1]?.resolve(' the whole thing ')
    await expect(final).resolves.toBe('the whole thing')
    expect(onPartial).not.toHaveBeenCalled()
  })

  it('takes no audio and starts no passes once finished', async () => {
    const { calls, transcribe } = controlledTranscriber()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial: vi.fn() })
    live.push(audio(200))
    const final = live.finish()
    live.push(audio(2000))
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.samples).toBe(RATE * 0.2)
    calls[0]?.resolve('short')
    await final
    await expect(live.finish()).rejects.toThrow()
  })

  it('finishes an empty capture without calling the server', async () => {
    const transcribe = vi.fn<Transcriber>()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial: vi.fn() })
    await expect(live.finish()).resolves.toBe('')
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('on cancel aborts the running pass and drops its result', async () => {
    const { calls, transcribe } = controlledTranscriber()
    const onPartial = vi.fn()
    const onPartialError = vi.fn()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial, onPartialError })
    live.push(audio(500))
    live.cancel()
    expect(live.cancelled).toBe(true)
    expect(calls[0]?.signal.aborted).toBe(true)
    live.push(audio(1000))
    await flush()
    expect(calls).toHaveLength(1)
    expect(onPartial).not.toHaveBeenCalled()
    expect(onPartialError).not.toHaveBeenCalled()
  })

  it('cancel during the final pass aborts it', async () => {
    const { calls, transcribe } = controlledTranscriber()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial: vi.fn() })
    live.push(audio(300))
    const final = live.finish()
    await flush()
    live.cancel()
    expect(calls[0]?.signal.aborted).toBe(true)
    await expect(final).rejects.toThrow()
  })

  it('cancel while finish waits for the aborted partial rejects without a final pass', async () => {
    const { calls, transcribe } = controlledTranscriber()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial: vi.fn() })
    live.push(audio(500))
    const final = live.finish()
    live.cancel()
    await expect(final).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('stops at the length cap and reports it once', () => {
    const { transcribe } = controlledTranscriber()
    const onLimit = vi.fn()
    const live = new LiveTranscription({ minPartialMs: 0, transcribe, onPartial: vi.fn(), onLimit, maxMs: 1000 })
    live.push(audio(800))
    live.push(audio(800))
    live.push(audio(800))
    expect(onLimit).toHaveBeenCalledOnce()
    expect(live.durationMs).toBe(1000)
  })
})
