export default defineEventHandler(async () => {
  await refreshMcpTools()
  await refreshEntityList()
  return { ok: true, toolCount: getMcpTools().length }
})
