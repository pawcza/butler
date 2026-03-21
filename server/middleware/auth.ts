export default defineEventHandler((event) => {
  const user = config.AUTH_USER
  const pass = config.AUTH_PASS

  if (!user || !pass) return

  if (getRequestURL(event).pathname === '/api/health') return

  const header = getRequestHeader(event, 'authorization')
  if (!header?.startsWith('Basic ')) {
    setResponseHeader(event, 'www-authenticate', 'Basic realm="butler-core"')
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString()
  const sep = decoded.indexOf(':')
  const reqUser = decoded.slice(0, sep)
  const reqPass = decoded.slice(sep + 1)

  if (reqUser !== user || reqPass !== pass) {
    setResponseHeader(event, 'www-authenticate', 'Basic realm="butler-core"')
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
})
