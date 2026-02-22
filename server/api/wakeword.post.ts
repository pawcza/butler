export default defineEventHandler(async (event) => {
  const form = await readFormData(event)
  const file = form.get('audio')
  if (!(file instanceof File)) {
    throw createError({ statusCode: 400, message: 'Missing audio field in form data' })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const heard = await transcribe(buffer, 'wav')
  return { heard }
})
