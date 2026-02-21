export async function synthesize(text: string): Promise<Buffer> {
  const response = await fetch(`${config.PIPER_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.PIPER_MODEL,
      input: text,
      voice: config.PIPER_VOICE,
      response_format: config.PIPER_RESPONSE_FORMAT,
      speed: 1,
      stream_format: 'audio',
      sample_rate: null,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)')
    throw new Error(`TTS ${response.status}: ${text}`)
  }

  return Buffer.from(await response.arrayBuffer())
}
