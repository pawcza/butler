export async function transcribe(audioBuffer: Buffer): Promise<string> {
  const formData = new FormData()
  // Browser MediaRecorder produces webm (Chrome) or ogg (Firefox).
  // Whisper detects actual format from file headers regardless of MIME type.
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/webm' })
  formData.append('file', blob, 'audio.webm')
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
