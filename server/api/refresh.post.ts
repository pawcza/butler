export default defineEventHandler(async () => {
  rebuildToolCache()
  await refreshEntityList()
  return { ok: true, toolCount: getOllamaTools().length }
})
