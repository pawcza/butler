import { config } from './config'
import { createLog } from './log'

const log = createLog('stt')

/** Wraps 16-bit mono PCM in a WAV header, the format every transcription server accepts. */
export function pcmToWav(pcm: Int16Array, sampleRate = 16000): Buffer {
  const dataSize = pcm.length * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8); buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i] ?? 0, 44 + i * 2)
  return buf
}

/** Send a tiny silent WAV so a self-hosted server loads its model before the first real request. */
export async function warmUpStt(): Promise<void> {
  const t0 = Date.now()
  log.info('warming up...')
  // 0.1s of silence
  await transcribe(pcmToWav(new Int16Array(1600)))
  log.ok(`warm in ${Date.now() - t0}ms`)
}

/** Transcribe a WAV file. `signal` cancels the request; it also gives up on its own after 30s. */
export async function transcribe(wav: Buffer, signal?: AbortSignal): Promise<string> {
  if (!config.STT_BASE_URL) throw new Error('speech recognition is not configured (STT_BASE_URL)')

  const formData = new FormData()
  formData.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
  formData.append('model', config.STT_MODEL)

  const timeout = AbortSignal.timeout(30_000)
  let response: Response
  try {
    response = await fetch(`${config.STT_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: config.STT_API_KEY ? { Authorization: `Bearer ${config.STT_API_KEY}` } : {},
      body: formData,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (err) {
    if (timeout.aborted && !signal?.aborted) throw new Error('STT request timed out after 30s')
    throw err
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)')
    throw new Error(`STT ${response.status}: ${text}`)
  }

  const result = (await response.json()) as { text?: string }
  return (result.text ?? '').trim()
}
