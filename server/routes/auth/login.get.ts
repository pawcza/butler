import { FLOW_COOKIE, FLOW_TTL_MS, seal, type AuthFlow } from '../../utils/auth-cookie'
import { buildAuthorizeUrl, createPkce, getDiscovery, randomToken, sanitizeReturnPath } from '../../utils/oidc'

const log = createLog('auth')

export default defineEventHandler(async (event) => {
  if (!oidc) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const { verifier, challenge } = createPkce()
  const flow: AuthFlow = {
    state: randomToken(),
    nonce: randomToken(),
    verifier,
    ret: sanitizeReturnPath(getQuery(event)['return']),
  }

  let target: string
  try {
    const discovery = await getDiscovery(oidc)
    target = buildAuthorizeUrl(discovery, oidc, { state: flow.state, nonce: flow.nonce, challenge })
  } catch (err) {
    log.fail('discovery failed:', err)
    return authPage(event, 502, 'Sign-in unavailable', 'Could not reach the identity provider.', {
      href: '/auth/login',
      label: 'Try again',
    })
  }

  setCookie(event, FLOW_COOKIE, seal(flow, oidc.sessionSecret, 'flow', FLOW_TTL_MS), authCookieOptions(FLOW_TTL_MS))
  return sendRedirect(event, target, 302)
})
