import { z } from 'zod'

const bodySchema = z.object({
  interactable: z.boolean(),
})

export default defineEventHandler(async (event) => {
  const deviceId = getRouterParam(event, 'id')
  if (!deviceId) {
    throw createError({ statusCode: 400, message: 'Missing device id' })
  }

  const body = await readBody(event)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: 'Body must be { interactable: boolean }' })
  }

  const decodedId = decodeURIComponent(deviceId)
  const updated = setDeviceInteractable(decodedId, parsed.data.interactable)
  if (!updated) {
    throw createError({ statusCode: 404, message: `Device not found: ${decodedId}` })
  }

  return { ok: true }
})
