import { z } from 'zod'
import type { ServerEvent } from '~/shared/types'

const bodySchema = z.object({
  text: z.string().min(1, 'text must not be empty'),
})

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: parsed.error.errors[0]?.message ?? 'Bad request' })
  }

  const events: ServerEvent[] = []
  const session = new SessionManager(() => {})
  await processCommand(parsed.data.text, session, (e) => events.push(e), 'api')
  return { events }
})
