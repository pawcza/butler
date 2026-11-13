import { FLOW_COOKIE, SESSION_COOKIE } from '../../utils/auth-cookie'
import { buildLogoutUrl, getDiscovery } from '../../utils/oidc'

const log = createLog('auth')

export default defineEventHandler(async (event) => {
  if (!oidc) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const session = getAuthSession(event)
  clearAuthCookie(event, SESSION_COOKIE)
  clearAuthCookie(event, FLOW_COOKIE)

  try {
    const discovery = await getDiscovery(oidc)
    const target = buildLogoutUrl(discovery, oidc, session?.idt)
    if (target) return sendRedirect(event, target, 302)
  } catch (err) {
    log.warn('no end-session redirect:', err)
  }
  return authPage(event, 200, 'Signed out', 'You have been signed out.', { href: '/auth/login', label: 'Sign in' })
})
