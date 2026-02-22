export default defineEventHandler(async () => {
  await buildRegistry()
  return { ok: true, count: getRegistry().devices.length }
})
