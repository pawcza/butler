import { config } from './config'
import { createLog } from './log'
import { createWarmup } from './tts-warmup'

export interface TtsOptions {
  model: string
  voice: string
}

const log = createLog('tts')

/** The first sentence of a slow engine can take a model load: 15 to 20 seconds. */
const SYNTH_TIMEOUT_MS = 60_000
const WARMUP_WORD = 'Ready'

/** The voice a text is read in: the one for its language when `TTS_VOICES` has one, else the default. */
export function voiceFor(language: string | null): TtsOptions {
  return (language !== null ? config.TTS_VOICES[language] : undefined)
    ?? { model: config.TTS_MODEL, voice: config.TTS_VOICE }
}

/** Synthesizes `text`. `signal` cancels the request; it also gives up on its own after 60s. */
export async function synthesize(text: string, opts: TtsOptions = voiceFor(null), signal?: AbortSignal): Promise<Buffer> {
  const { model, voice } = opts
  log.info(`synthesize: ${text.length}ch | model=${model} voice=${voice} → "${text.slice(0, 100)}"`)
  const timeout = AbortSignal.timeout(SYNTH_TIMEOUT_MS)

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
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) {
      const errBody = await response.text().catch(() => '(no body)')
      throw new Error(`TTS ${response.status}: ${errBody}`)
    }
    const audio = Buffer.from(await response.arrayBuffer())
    warmup.touch()
    return audio
  } catch (err) {
    if (timeout.aborted && !signal?.aborted) throw new Error(`TTS request timed out after ${SYNTH_TIMEOUT_MS / 1000}s`)
    throw err
  }
}

const warmup = createWarmup({ run: () => synthesize(WARMUP_WORD) })

/** With `TTS_WARMUP` on, loads the speech model in the background when a turn starts. Never throws. */
export function warmUpSpeech(): void {
  if (config.TTS_WARMUP && config.TTS_BASE_URL) warmup.fire()
}
