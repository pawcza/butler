export default defineEventHandler(async () => {
  await refreshMcpTools()
  rebuildToolCache()
  await refreshEntityList()
  return { ok: true, toolCount: getMcpTools().length }
})
