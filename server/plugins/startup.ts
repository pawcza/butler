export default defineNitroPlugin(async () => {
  // Importing config triggers Zod validation — exits process if env is invalid
  const _config = config

  console.log('[butler] Connecting to Home Assistant and building registry...')
  try {
    await buildRegistry()
  } catch (err) {
    console.error('[butler] WARNING: Could not build HA registry:', err)
    console.error('[butler] Continuing with empty registry. Use POST /api/entities/refresh when HA is reachable.')
  }

  console.log('[butler] GLaDOS is online.')
})
