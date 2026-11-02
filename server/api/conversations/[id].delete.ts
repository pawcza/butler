export default defineEventHandler(async (event) => {
  const removed = await conversationStore.remove(getRouterParam(event, 'id') ?? '')
  if (!removed) throw createError({ statusCode: 404, message: 'Conversation not found' })
  return { ok: true }
})
