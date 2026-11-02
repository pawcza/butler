const log = createLog('stt')

/** Send a tiny silent WAV so a self-hosted server loads its model before the first real request. */
export async function warmUpStt(): Promise<void> {
  const t0 = Date.now()
  log.info('warming up...')
  // 0.1s of silence at 16kHz mono 16-bit PCM
  const samples = 1600
  const dataSize = samples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8); buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40)
  // PCM data stays zero (silence)
  await transcribe(buf, 'wav')
  log.ok(`warm in ${Date.now() - t0}ms`)
}

export async function transcribe(
  audioBuffer: Buffer,
  format: 'webm' | 'wav' = 'webm',
): Promise<string> {
  if (!config.STT_BASE_URL) throw new Error('speech recognition is not configured (STT_BASE_URL)')

  const mimeType = format === 'wav' ? 'audio/wav' : 'audio/webm'
  const filename = `audio.${format}`

  const formData = new FormData()
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType })
  formData.append('file', blob, filename)
  formData.append('model', config.STT_MODEL)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  let response: Response
  try {
    response = await fetch(`${config.STT_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: config.STT_API_KEY ? { Authorization: `Bearer ${config.STT_API_KEY}` } : {},
      body: formData,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('STT request timed out after 30s')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)')
    throw new Error(`STT ${response.status}: ${text}`)
  }

  const result = (await response.json()) as { text?: string }
  return (result.text ?? '').trim()
}
