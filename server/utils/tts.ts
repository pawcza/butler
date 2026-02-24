export async function synthesize(text: string): Promise<Buffer> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  let response: Response
  try {
    response = await fetch(`${config.PIPER_URL}/v1/audio/speech`, {
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
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('TTS request timed out after 30s')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '(no body)')
    throw new Error(`TTS ${response.status}: ${errBody}`)
  }

  return Buffer.from(await response.arrayBuffer())
}
