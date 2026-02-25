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

  // Warm up Whisper model so first request isn't slow.
  // Retry a few times — the Whisper container may still be booting.
  const sttLog = createLog('stt')
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await warmUpStt()
      break
    } catch {
      sttLog.warn(`warm-up attempt ${attempt}/5 failed — retrying in 3s…`)
      if (attempt < 5) await new Promise((r) => setTimeout(r, 3000))
    }
  }

  log.ok('Butler is online.')
})
