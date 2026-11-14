// AudioWorklet: microphone audio in, 16 kHz mono Int16 frames of AUDIO_FRAME_MS out on the port.
// Loaded through `?worker&url`, so it is bundled on its own and may only import plain modules.
import { AUDIO_FRAME_MS, PCM_SAMPLE_RATE } from '../shared/audio'
import { StreamResampler, floatToInt16 } from '../utils/pcm'

// AudioWorkletGlobalScope, which TypeScript ships no lib for
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

const FRAME_SAMPLES = (PCM_SAMPLE_RATE * AUDIO_FRAME_MS) / 1000

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new StreamResampler(sampleRate, PCM_SAMPLE_RATE)
  private readonly frame = new Float32Array(FRAME_SAMPLES)
  private fill = 0

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    const samples = this.resampler.process(channel)
    let read = 0
    while (read < samples.length) {
      const take = Math.min(samples.length - read, FRAME_SAMPLES - this.fill)
      this.frame.set(samples.subarray(read, read + take), this.fill)
      this.fill += take
      read += take
      if (this.fill === FRAME_SAMPLES) {
        const pcm = floatToInt16(this.frame)
        this.port.postMessage(pcm, [pcm.buffer])
        this.fill = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
