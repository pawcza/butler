export default defineEventHandler(async (event) => {
  const thread = await conversationStore.thread(getRouterParam(event, 'id') ?? '')
  if (!thread) throw createError({ statusCode: 404, message: 'Conversation not found' })
  return thread
})
