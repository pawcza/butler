import { describe, expect, it } from 'vitest'
import { MAX_CAPTURE_SECONDS, MAX_JSON_FRAME_BYTES, MAX_WAKE_UPLOAD_BYTES, PCM_SAMPLE_RATE } from '../shared/audio'
import { readBounded } from '../server/utils/bounded-body'
import { float32ToWav } from '../utils/wav'

function streamOf(...parts: Uint8Array[]): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[pulled]
      pulled += 1
      if (part) controller.enqueue(part)
      else controller.close()
    },
  })
  return { stream, pulled: () => pulled }
}

describe('input limits', () => {
  it('the wake word upload limit is a full capture of 16 kHz mono 16-bit audio in a WAV, and no more', () => {
    expect(float32ToWav(new Float32Array(PCM_SAMPLE_RATE * MAX_CAPTURE_SECONDS)).byteLength).toBe(MAX_WAKE_UPLOAD_BYTES)
    expect(float32ToWav(new Float32Array(PCM_SAMPLE_RATE * 2)).byteLength).toBeLessThan(MAX_WAKE_UPLOAD_BYTES)
  })

  it('a text frame has room for a long typed command, and a few KB is all it has', () => {
    const command = JSON.stringify({ type: 'command', text: 'Zgaś światło w kuchni. '.repeat(100) })
    expect(new TextEncoder().encode(command).length).toBeLessThan(MAX_JSON_FRAME_BYTES)
    expect(MAX_JSON_FRAME_BYTES).toBeLessThanOrEqual(8 * 1024)
  })

  describe('readBounded', () => {
    it('reads a body within the limit whole', async () => {
      const { stream } = streamOf(new Uint8Array([1, 2]), new Uint8Array([3]))
      expect([...(await readBounded(stream, 3)) ?? []]).toEqual([1, 2, 3])
    })

    it('gives up as soon as the limit is passed, without reading the rest', async () => {
      const chunk = new Uint8Array(10)
      const { stream, pulled } = streamOf(chunk, chunk, chunk, chunk, chunk, chunk)
      expect(await readBounded(stream, 25)).toBeNull()
      // the stream is cancelled after the chunk that crossed the line: the other three are never pulled
      expect(pulled()).toBeLessThanOrEqual(4)
    })

    it('reads an empty body as empty', async () => {
      expect((await readBounded(streamOf().stream, 10))?.length).toBe(0)
    })
  })
})
