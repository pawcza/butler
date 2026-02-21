import { z } from 'zod'

const bodySchema = z.object({
  interactable: z.boolean(),
})

export default defineEventHandler(async (event) => {
  const entityId = getRouterParam(event, 'id')
  if (!entityId) {
    throw createError({ statusCode: 400, message: 'Missing entity id' })
  }

  const body = await readBody(event)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: 'Body must be { interactable: boolean }' })
  }

  const updated = setEntityInteractable(decodeURIComponent(entityId), parsed.data.interactable)
  if (!updated) {
    throw createError({ statusCode: 404, message: `Entity not found: ${entityId}` })
  }

  return { ok: true }
})
