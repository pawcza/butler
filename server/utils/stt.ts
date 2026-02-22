export async function transcribe(
  audioBuffer: Buffer,
  format: 'webm' | 'wav' = 'webm',
): Promise<string> {
  const mimeType = format === 'wav' ? 'audio/wav' : 'audio/webm'
  const filename = `audio.${format}`

  const formData = new FormData()
  // Whisper detects actual format from file headers regardless of MIME type,
  // but we set it correctly to be well-behaved.
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType })
  formData.append('file', blob, filename)
  formData.append('model', config.WHISPER_MODEL)

  const response = await fetch(`${config.WHISPER_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)')
    throw new Error(`STT ${response.status}: ${text}`)
  }

  const result = (await response.json()) as { text?: string }
  return (result.text ?? '').trim()
}
