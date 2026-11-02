export interface TtsOptions {
  model?: string
  voice?: string
}

const log = createLog('tts')

/** "null"/empty strings can leak in from stale client-side localStorage; treat them as unset. */
function usable(v: string | undefined): v is string {
  return typeof v === 'string' && v.length > 0 && v !== 'null' && v !== 'undefined'
}

export async function synthesize(text: string, opts?: TtsOptions): Promise<Buffer> {
  const model = usable(opts?.model) ? opts.model : config.TTS_MODEL
  const voice = usable(opts?.voice) ? opts.voice : config.TTS_VOICE
  log.info(`synthesize: ${text.length}ch | model=${model} voice=${voice} → "${text.slice(0, 100)}"`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  let response: Response
  try {
    response = await fetch(`${config.TTS_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.TTS_API_KEY ? { Authorization: `Bearer ${config.TTS_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: config.TTS_RESPONSE_FORMAT,
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
