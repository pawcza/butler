import type { TtsModelInfo } from '~/shared/types'

interface SpeachesVoice {
  id: string
  name: string
  [key: string]: unknown
}

interface SpeachesModel {
  id: string
  task?: string
  voices?: SpeachesVoice[]
  [key: string]: unknown
}

interface SpeachesModelsResponse {
  data: SpeachesModel[]
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
      voices: m.voices?.map((v) => v.id) ?? [],
    }))

  return {
    models,
    defaults: {
      model: config.PIPER_MODEL,
      voice: config.PIPER_VOICE,
    },
  }
})
