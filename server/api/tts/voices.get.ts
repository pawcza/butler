import type { TtsModelInfo } from '~/shared/types'

/**
 * `/models` has no standard way to list voices. Speaches adds `task` and `voices` to each
 * model, as plain strings or as objects with id/name depending on the version. Any other
 * server just leaves the voice picker empty.
 */
type ModelVoice = string | { id?: string; name?: string; [key: string]: unknown }

interface SpeechModel {
  id: string
  task?: string
  voices?: ModelVoice[]
  [key: string]: unknown
}

interface ModelsResponse {
  data: SpeechModel[]
}

function voiceToString(v: ModelVoice): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null
  if (v && typeof v === 'object') {
    if (typeof v.id === 'string' && v.id.length > 0) return v.id
    if (typeof v.name === 'string' && v.name.length > 0) return v.name
  }
  return null
}

export default defineEventHandler(async () => {
  const defaults = { model: config.TTS_MODEL, voice: config.TTS_VOICE }
  const stt = Boolean(config.STT_BASE_URL)
  if (!config.TTS_BASE_URL) return { models: [], defaults, stt }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  let response: Response
  try {
    response = await fetch(`${config.TTS_BASE_URL}/models`, {
      headers: config.TTS_API_KEY ? { Authorization: `Bearer ${config.TTS_API_KEY}` } : {},
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw createError({ statusCode: 504, statusMessage: 'TTS request timed out' })
    }
    throw createError({ statusCode: 502, statusMessage: 'Could not reach TTS server' })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    throw createError({ statusCode: response.status, statusMessage: `TTS server returned ${response.status}` })
  }

  const body = (await response.json()) as ModelsResponse
  const models: TtsModelInfo[] = body.data
    .filter((m) => m.task === 'text-to-speech')
    .map((m) => ({
      id: m.id,
      voices: (m.voices ?? [])
        .map(voiceToString)
        .filter((v): v is string => v !== null),
    }))

  return { models, defaults, stt }
})
