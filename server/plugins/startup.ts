export default defineNitroPlugin(async () => {
  const log = createLog('butler')

  // Importing config triggers Zod validation — exits process if env is invalid
  const _config = config

  // Verify HA is reachable
  try {
    await haFetch('/')
    log.ok('Home Assistant connected.')
  } catch (err) {
    log.fail('Could not reach Home Assistant:', err)
  }

  buildRegistry()

  try {
    await refreshEntityList()
  } catch (err) {
    log.warn('Could not fetch entity list:', err)
  }

  // Warm up Whisper model so first request isn't slow
  warmUpStt().catch(() => {})

  log.ok('GLaDOS is online.')
})
