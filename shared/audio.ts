/** Live microphone audio on the WebSocket: 16 kHz mono 16-bit PCM, little-endian. */
export const PCM_SAMPLE_RATE = 16000

/** Length of one live frame from the microphone worklet. */
export const AUDIO_FRAME_MS = 100

/** Microphone history the client keeps for pre-roll. A capture's first frame may carry all of it. */
export const PRE_ROLL_RING_SECONDS = 10

/** Longest live capture the server keeps (see `LiveTranscription`). */
export const MAX_CAPTURE_SECONDS = 60

/** Largest JSON text frame the server reads. A typed command is the longest message by far. */
export const MAX_JSON_FRAME_BYTES = 4096

/** Size of the WAV header in front of 16-bit PCM (see `float32ToWav`). */
const WAV_HEADER_BYTES = 44

/** Largest WAV the wake word check accepts: a whole capture's length of audio, plus the header. */
export const MAX_WAKE_UPLOAD_BYTES = WAV_HEADER_BYTES + PCM_SAMPLE_RATE * MAX_CAPTURE_SECONDS * 2

const frameBytes = (ms: number): number => 1 + ((PCM_SAMPLE_RATE * ms) / 1000) * 2

/** Largest legitimate tagged frame: the first of a capture holds the whole pre-roll ring. */
export const MAX_FIRST_FRAME_BYTES = frameBytes(PRE_ROLL_RING_SECONDS * 1000)

/** Largest legitimate tagged frame after the first. */
export const MAX_LIVE_FRAME_BYTES = frameBytes(AUDIO_FRAME_MS)

/**
 * Size gate for the binary frames of one capture. `admit` is given a frame's byte length, before the
 * payload is touched, and says whether to keep it; the first frame dropped answers `drop-first`, so
 * the caller logs once per capture.
 */
export class FrameBudget {
  private frames = 0
  private warned = false

  admit(byteLength: number): 'ok' | 'drop-first' | 'drop' {
    const limit = this.frames === 0 ? MAX_FIRST_FRAME_BYTES : MAX_LIVE_FRAME_BYTES
    this.frames += 1
    if (byteLength <= limit) return 'ok'
    if (this.warned) return 'drop'
    this.warned = true
    return 'drop-first'
  }
}

/**
 * First byte of every binary audio frame. Client JSON messages always start with `{` (0x7b), and
 * raw PCM can start with any byte, so the tag is what tells the two apart.
 */
export const AUDIO_FRAME_TAG = 0x01

export function encodeAudioFrame(pcm: Int16Array): Uint8Array {
  const frame = new Uint8Array(1 + pcm.byteLength)
  frame[0] = AUDIO_FRAME_TAG
  frame.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1)
  return frame
}

/** The PCM in a tagged frame, or null when the frame isn't one. A trailing odd byte is dropped. */
export function decodeAudioFrame(frame: Uint8Array): Int16Array | null {
  if (frame[0] !== AUDIO_FRAME_TAG) return null
  const pcm = new Int16Array((frame.length - 1) >> 1)
  // copied rather than viewed: the payload starts at an odd offset
  new Uint8Array(pcm.buffer).set(frame.subarray(1, 1 + pcm.byteLength))
  return pcm
}
