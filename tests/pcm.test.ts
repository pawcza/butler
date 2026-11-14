import { describe, expect, it } from 'vitest'
import { PcmRing, StreamResampler, floatToInt16 } from '../utils/pcm'
import {
  AUDIO_FRAME_TAG, FrameBudget, MAX_FIRST_FRAME_BYTES, MAX_LIVE_FRAME_BYTES, PCM_SAMPLE_RATE, PRE_ROLL_RING_SECONDS,
  decodeAudioFrame, encodeAudioFrame,
} from '../shared/audio'

const sine = (rate: number, hz: number, seconds: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate))

const rms = (x: Float32Array, skip = 0) => {
  let sum = 0
  for (let i = skip; i < x.length; i++) sum += (x[i] ?? 0) ** 2
  return Math.sqrt(sum / (x.length - skip))
}

/** Runs the input through in blocks, the way the worklet does (128-sample render quanta). */
function resampleInBlocks(r: StreamResampler, input: Float32Array, block = 128): Float32Array {
  const parts: Float32Array[] = []
  for (let i = 0; i < input.length; i += block) parts.push(r.process(input.subarray(i, i + block)))
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

describe('StreamResampler', () => {
  for (const rate of [48000, 44100]) {
    it(`turns ${rate} Hz into 16 kHz, keeping a speech-band tone`, () => {
      const out = resampleInBlocks(new StreamResampler(rate, 16000), sine(rate, 1000, 1))
      // all but the kernel's look-ahead comes out
      expect(out.length).toBeGreaterThan(15950)
      expect(out.length).toBeLessThanOrEqual(16000)
      const expected = sine(16000, 1000, 1)
      let maxErr = 0
      for (let i = 100; i < out.length - 100; i++) maxErr = Math.max(maxErr, Math.abs((out[i] ?? 0) - (expected[i] ?? 0)))
      expect(maxErr).toBeLessThan(0.01)
    })

    it(`filters out what 16 kHz can't hold from ${rate} Hz instead of aliasing it`, () => {
      const out = resampleInBlocks(new StreamResampler(rate, 16000), sine(rate, 12000, 1))
      expect(rms(out, 100)).toBeLessThan(0.005)
    })
  }

  it('gives the same output whatever the block size', () => {
    const input = sine(44100, 440, 0.5)
    const a = resampleInBlocks(new StreamResampler(44100, 16000), input, 128)
    const b = resampleInBlocks(new StreamResampler(44100, 16000), input, 1000)
    expect(b.length).toBe(a.length)
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i] ?? 0, 6)
  })

  it('passes 16 kHz through untouched', () => {
    const input = sine(16000, 300, 0.1)
    expect(Array.from(new StreamResampler(16000, 16000).process(input))).toEqual(Array.from(input))
  })
})

describe('floatToInt16', () => {
  it('scales and clips', () => {
    expect(Array.from(floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16383])
  })
})

describe('PcmRing', () => {
  const seq = (from: number, n: number) => Int16Array.from({ length: n }, (_, i) => from + i)

  it('reads back everything since a position', () => {
    const ring = new PcmRing(10)
    ring.write(seq(0, 4))
    const mark = ring.position
    ring.write(seq(4, 3))
    expect(Array.from(ring.readSince(mark))).toEqual([4, 5, 6])
    expect(ring.position).toBe(7)
  })

  it('wraps around and keeps only the newest samples', () => {
    const ring = new PcmRing(5)
    ring.write(seq(0, 4))
    ring.write(seq(4, 4))
    expect(Array.from(ring.readSince(0))).toEqual([3, 4, 5, 6, 7])
    ring.write(seq(8, 12))
    expect(Array.from(ring.readSince(0))).toEqual([15, 16, 17, 18, 19])
    expect(ring.position).toBe(20)
  })

  it('gives the pre-roll before a press, or what there is of it', () => {
    const ring = new PcmRing(100)
    ring.write(seq(0, 30))
    expect(Array.from(ring.readSince(ring.position - 6))).toEqual([24, 25, 26, 27, 28, 29])
    const young = new PcmRing(100)
    young.write(seq(0, 3))
    expect(Array.from(young.readSince(young.position - 6))).toEqual([0, 1, 2])
  })

  it('reads nothing from the current position', () => {
    const ring = new PcmRing(4)
    ring.write(seq(0, 3))
    expect(ring.readSince(ring.position)).toHaveLength(0)
  })
})

describe('audio frames', () => {
  it('round-trips PCM, even when the samples start with the JSON brace byte', () => {
    const pcm = Int16Array.from([0x7b7b, -1, 0, 32767])
    const frame = encodeAudioFrame(pcm)
    expect(frame[0]).toBe(AUDIO_FRAME_TAG)
    expect(Array.from(decodeAudioFrame(frame) ?? [])).toEqual(Array.from(pcm))
  })

  it('rejects anything not tagged as audio', () => {
    expect(decodeAudioFrame(new TextEncoder().encode('{"type":"ping"}'))).toBeNull()
  })

  it('decodes a frame inside a larger buffer', () => {
    const frame = encodeAudioFrame(Int16Array.from([1, 2, 3]))
    const big = new Uint8Array(frame.length + 3)
    big.set(frame, 3)
    expect(Array.from(decodeAudioFrame(big.subarray(3)) ?? [])).toEqual([1, 2, 3])
  })
})

describe('FrameBudget', () => {
  const frame = (samples: number) => encodeAudioFrame(new Int16Array(samples)).length

  it('bounds come from the shared constants: the whole ring, then 100 ms', () => {
    expect(MAX_FIRST_FRAME_BYTES).toBe(frame(PCM_SAMPLE_RATE * PRE_ROLL_RING_SECONDS))
    expect(MAX_LIVE_FRAME_BYTES).toBe(frame(PCM_SAMPLE_RATE / 10))
  })

  it('lets the first frame carry the full ring and later frames 100 ms', () => {
    const budget = new FrameBudget()
    expect(budget.admit(MAX_FIRST_FRAME_BYTES)).toBe('ok')
    expect(budget.admit(MAX_LIVE_FRAME_BYTES)).toBe('ok')
  })

  it('drops anything larger, and says so only for the first drop of a capture', () => {
    const budget = new FrameBudget()
    expect(budget.admit(MAX_FIRST_FRAME_BYTES + 1)).toBe('drop-first')
    expect(budget.admit(MAX_LIVE_FRAME_BYTES + 1)).toBe('drop')
    expect(budget.admit(MAX_LIVE_FRAME_BYTES)).toBe('ok')
  })

  it('a pre-roll sized frame is too big once the first frame has gone by', () => {
    const budget = new FrameBudget()
    expect(budget.admit(10)).toBe('ok')
    expect(budget.admit(MAX_FIRST_FRAME_BYTES)).toBe('drop-first')
  })
})
