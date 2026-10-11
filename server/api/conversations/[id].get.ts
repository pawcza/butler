export default defineEventHandler((event) => conversationStore.thread(getRouterParam(event, 'id') ?? ''))
