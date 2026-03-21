export interface TtsOptions {
  model?: string
  voice?: string
}

const log = createLog('tts')

async function doSynthesize(text: string, opts: TtsOptions | undefined, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(`${config.PIPER_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts?.model ?? config.PIPER_MODEL,
      input: text,
      voice: opts?.voice ?? config.PIPER_VOICE,
      response_format: config.PIPER_RESPONSE_FORMAT,
      speed: 1,
      stream_format: 'audio',
      sample_rate: null,
    }),
    signal,
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '(no body)')
    throw new Error(`TTS ${response.status}: ${errBody}`)
  }

  return Buffer.from(await response.arrayBuffer())
}

export async function synthesize(text: string, opts?: TtsOptions): Promise<Buffer> {
  log.info(`synthesize: ${text.length}ch → "${text.slice(0, 100)}"`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  try {
    return await doSynthesize(text, opts, controller.signal)
  } catch (err) {
    clearTimeout(timeout)
    const msg = err instanceof Error ? err.message : String(err)

    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('TTS request timed out after 30s')
    }

    // "Terminated" = Node fetch connection killed (VRAM pressure, container restart).
    // Retry once after a short delay.
    if (msg === 'Terminated' || msg.includes('terminated')) {
      log.warn('TTS connection terminated — retrying in 1s')
      await new Promise(r => setTimeout(r, 1000))
      const retryController = new AbortController()
      const retryTimeout = setTimeout(() => retryController.abort(), 30_000)
      try {
        return await doSynthesize(text, opts, retryController.signal)
      } catch (retryErr) {
        clearTimeout(retryTimeout)
        throw retryErr
      } finally {
        clearTimeout(retryTimeout)
      }
    }

    throw err
  } finally {
    clearTimeout(timeout)
  }
}
