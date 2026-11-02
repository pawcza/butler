import { matchWakeWord } from '~/shared/text'

export default defineEventHandler(async (event) => {
  const form = await readFormData(event)
  const file = form.get('audio')
  if (!(file instanceof File)) {
    throw createError({ statusCode: 400, message: 'Missing audio field in form data' })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  let heard: string
  try {
    heard = await transcribe(buffer, 'wav')
  } catch (err) {
    throw createError({
      statusCode: 502,
      message: err instanceof Error ? err.message : 'STT service unavailable',
    })
  }
  return { heard, command: matchWakeWord(heard, config.WAKE_WORD) }
})
