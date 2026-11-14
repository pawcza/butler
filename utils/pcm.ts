/** Kernel half-width, in zero crossings of the low-pass sinc. More is sharper and slower. */
const ZERO_CROSSINGS = 12
/** Kernel table entries per input sample; taps between entries are interpolated. */
const TABLE_STEPS = 128
/** Passband edge as a share of the output Nyquist frequency, leaving room for the roll-off. */
const PASSBAND = 0.92

/**
 * Streaming sample-rate converter for mono float audio: windowed-sinc (Blackman) interpolation
 * with a low-pass at the lower of the two Nyquist frequencies, so downsampling doesn't alias.
 * Works for any rate pair, including 44.1 kHz to 16 kHz. Feed it blocks of any size.
 */
export class StreamResampler {
  private readonly ratio: number
  private readonly halfWidth: number
  private readonly table: Float32Array
  private readonly passthrough: boolean
  /** Unconsumed input, starting `halfWidth` samples of history before the next output. */
  private buffer: Float32Array
  private fill: number
  /** Position of the next output sample, in input samples from the start of `buffer`. */
  private t: number

  constructor(inputRate: number, outputRate: number) {
    this.ratio = inputRate / outputRate
    this.passthrough = inputRate === outputRate
    // cutoff in cycles per input sample
    const cutoff = (Math.min(inputRate, outputRate) / 2 / inputRate) * PASSBAND
    this.halfWidth = Math.ceil(ZERO_CROSSINGS / (2 * cutoff))
    const size = this.halfWidth * TABLE_STEPS
    this.table = new Float32Array(size + 2)
    for (let i = 0; i <= size; i++) {
      const x = i / TABLE_STEPS
      const arg = 2 * cutoff * x
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg)
      const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / this.halfWidth) + 0.08 * Math.cos((2 * Math.PI * x) / this.halfWidth)
      this.table[i] = sinc * w
    }
    this.buffer = new Float32Array(4096)
    // zero history, so the first output lines up with the first input sample
    this.fill = this.halfWidth
    this.t = this.halfWidth
  }

  process(input: Float32Array): Float32Array {
    if (this.passthrough) return input.slice()
    this.append(input)
    const hw = this.halfWidth
    const count = Math.max(0, Math.floor((this.fill - 1 - hw - this.t) / this.ratio) + 1)
    const out = new Float32Array(count)
    let t = this.t
    for (let n = 0; n < count; n++) {
      const first = Math.ceil(t - hw)
      const last = Math.floor(t + hw)
      let sum = 0
      let weights = 0
      for (let k = first; k <= last; k++) {
        const pos = Math.abs(t - k) * TABLE_STEPS
        const i = Math.floor(pos)
        const a = this.table[i] ?? 0
        const b = this.table[i + 1] ?? 0
        const w = a + (b - a) * (pos - i)
        sum += (this.buffer[k] ?? 0) * w
        weights += w
      }
      // dividing by the weights keeps DC gain exactly 1 whatever the fractional phase
      out[n] = weights !== 0 ? sum / weights : 0
      t += this.ratio
    }
    // drop input that no future output can reach
    const keepFrom = Math.max(0, Math.floor(t - hw))
    this.buffer.copyWithin(0, keepFrom, this.fill)
    this.fill -= keepFrom
    this.t = t - keepFrom
    return out
  }

  private append(input: Float32Array): void {
    if (this.fill + input.length > this.buffer.length) {
      const grown = new Float32Array(Math.max(this.buffer.length * 2, this.fill + input.length))
      grown.set(this.buffer.subarray(0, this.fill))
      this.buffer = grown
    }
    this.buffer.set(input, this.fill)
    this.fill += input.length
  }
}

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/**
 * The last `capacity` samples of a continuous stream. Positions count every sample ever written,
 * so a moment can be marked with `position` and everything since read back later.
 */
export class PcmRing {
  private readonly data: Int16Array
  private written = 0

  constructor(capacity: number) {
    this.data = new Int16Array(capacity)
  }

  /** Samples written so far. */
  get position(): number {
    return this.written
  }

  write(samples: Int16Array): void {
    const cap = this.data.length
    // only the newest `cap` samples can survive
    const src = samples.length > cap ? samples.subarray(samples.length - cap) : samples
    const start = (this.written + samples.length - src.length) % cap
    const head = Math.min(src.length, cap - start)
    this.data.set(src.subarray(0, head), start)
    if (head < src.length) this.data.set(src.subarray(head), 0)
    this.written += samples.length
  }

  /** A copy of everything from `from` to now, or as much of it as is still kept. */
  readSince(from: number): Int16Array {
    const cap = this.data.length
    const start = Math.max(from, this.written - cap, 0)
    const length = Math.max(0, this.written - start)
    const out = new Int16Array(length)
    const offset = start % cap
    const head = Math.min(length, cap - offset)
    out.set(this.data.subarray(offset, offset + head))
    if (head < length) out.set(this.data.subarray(0, length - head), head)
    return out
  }
}
