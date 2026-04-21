export default defineNitroPlugin(async () => {
  const log = createLog('butler')

  // Importing config triggers Zod validation — exits process if env is invalid
  const _config = config

  // Warm up Whisper model so first request isn't slow.
  // Retry a few times — the Whisper container may still be booting.
  const sttLog = createLog('stt')
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await warmUpStt()
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sttLog.warn(`warm-up attempt ${attempt}/5 failed: ${msg} — retrying in 3s…`)
      if (attempt < 5) await new Promise((r) => setTimeout(r, 3000))
    }
  }

  log.ok('Butler is online.')
})
