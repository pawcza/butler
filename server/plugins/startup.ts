export default defineNitroPlugin(async () => {
  // Importing config triggers Zod validation — exits process if env is invalid
  const _config = config

  console.log('[butler] Connecting to MCP server...')
  try {
    await buildRegistry()
  } catch (err) {
    console.error('[butler] WARNING: Could not connect to MCP server:', err)
    console.error('[butler] Continuing with empty tool list. Use POST /api/refresh when MCP is reachable.')
  }

  try {
    await refreshEntityList()
  } catch (err) {
    console.warn('[butler] WARNING: Could not fetch entity list:', err)
  }

  console.log('[butler] GLaDOS is online.')
})
