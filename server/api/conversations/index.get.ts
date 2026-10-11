export default defineEventHandler((event) => {
  const before = getQuery(event)['before']
  return conversationStore.list(typeof before === 'string' && before ? before : undefined)
})
