// Pages and endpoints that must work without a session: the health probe, the login routes,
// and the assets the browser fetches before it knows who you are.
const OPEN_PREFIXES = ['/auth/', '/_nuxt/', '/_vad/']
const OPEN_PATHS = new Set(['/api/health', '/favicon.ico'])

export default defineEventHandler((event) => {
  if (!oidc) return

  const url = getRequestURL(event)
  const path = url.pathname
  if (OPEN_PATHS.has(path) || OPEN_PREFIXES.some((prefix) => path.startsWith(prefix))) return

  const session = getAuthSession(event)
  if (session) {
    event.context['auth'] = session
    return
  }

  const wantsPage = getRequestHeader(event, 'accept')?.includes('text/html') && event.method === 'GET'
  if (wantsPage) {
    return sendRedirect(event, `/auth/login?return=${encodeURIComponent(path + url.search)}`, 302)
  }
  throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
})
