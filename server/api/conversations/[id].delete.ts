export default defineEventHandler((event) => conversationStore.remove(getRouterParam(event, 'id') ?? ''))
