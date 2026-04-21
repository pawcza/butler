import type { TtsModelInfo } from '~/shared/types'

/** Speaches returns voices either as plain strings or as objects with id/name. Both shapes are seen across versions. */
type SpeachesVoice = string | { id?: string; name?: string; [key: string]: unknown }

interface SpeachesModel {
  id: string
  task?: string
  voices?: SpeachesVoice[]
  [key: string]: unknown
}

interface SpeachesModelsResponse {
  data: SpeachesModel[]
}

function voiceToString(v: SpeachesVoice): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null
  if (v && typeof v === 'object') {
    if (typeof v.id === 'string' && v.id.length > 0) return v.id
    if (typeof v.name === 'string' && v.name.length > 0) return v.name
  }
  return null
}

export default defineEventHandler(async () => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  let response: Response
  try {
    response = await fetch(`${config.PIPER_URL}/v1/models`, {
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw createError({ statusCode: 504, statusMessage: 'Speaches request timed out' })
    }
    throw createError({ statusCode: 502, statusMessage: 'Could not reach Speaches' })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    throw createError({ statusCode: response.status, statusMessage: `Speaches returned ${response.status}` })
  }

  const body = (await response.json()) as SpeachesModelsResponse
  const models: TtsModelInfo[] = body.data
    .filter((m) => m.task === 'text-to-speech')
    .map((m) => ({
      id: m.id,
      voices: (m.voices ?? [])
        .map(voiceToString)
        .filter((v): v is string => v !== null),
    }))

  return {
    models,
    defaults: {
      model: config.PIPER_MODEL,
      voice: config.PIPER_VOICE,
    },
  }
})
