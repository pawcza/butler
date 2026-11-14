import { MAX_WAKE_UPLOAD_BYTES } from '~/shared/audio'
import { matchWakeWord } from '~/shared/text'

/** Room for the multipart boundary and field headers around the audio. */
const FORM_OVERHEAD_BYTES = 1024

function tooLarge(): never {
  throw createError({ statusCode: 413, message: 'Audio too large' })
}

export default defineEventHandler(async (event) => {
  const limit = MAX_WAKE_UPLOAD_BYTES + FORM_OVERHEAD_BYTES
  // a body that says up front it is too big is refused unread
  const declared = Number(getRequestHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > limit) tooLarge()

  const stream = getRequestWebStream(event)
  const body = stream ? await readBounded(stream, limit) : Buffer.alloc(0)
  if (!body) tooLarge()
  const type = getRequestHeader(event, 'content-type') ?? ''
  const form = await new Response(new Uint8Array(body), { headers: { 'content-type': type } }).formData().catch(() => null)
  const file = form?.get('audio')
  if (!(file instanceof File)) {
    throw createError({ statusCode: 400, message: 'Missing audio field in form data' })
  }
  if (file.size > MAX_WAKE_UPLOAD_BYTES) tooLarge()

  const buffer = Buffer.from(await file.arrayBuffer())
  let heard: string
  try {
    heard = await transcribe(buffer)
  } catch (err) {
    throw createError({
      statusCode: 502,
      message: err instanceof Error ? err.message : 'STT service unavailable',
    })
  }
  return { heard, command: matchWakeWord(heard, config.WAKE_WORD) }
})
