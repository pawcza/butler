export default defineNitroPlugin((nitroApp) => {
  const log = createLog('butler')

  nitroApp.hooks.hook('close', () => mcpToolbox.close())
  void mcpToolbox.connect()
  void warmUp()

  log.ok(`Butler is online. LLM: ${config.LLM_MODEL} at ${config.LLM_BASE_URL}`)
})

/**
 * Self-hosted speech servers load their model on the first request, so make that request
 * now. Retry a few times, because the service may still be booting.
 */
async function warmUp(): Promise<void> {
  if (!config.STT_BASE_URL) return
  const log = createLog('stt')
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await warmUpStt()
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(`warm-up attempt ${attempt}/5 failed: ${msg}`)
      if (attempt < 5) await new Promise((r) => setTimeout(r, 3000))
    }
  }
}
