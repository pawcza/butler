import {
  FLOW_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  readCookie,
  seal,
  unseal,
  type AuthFlow,
  type AuthSession,
} from '../../utils/auth-cookie'
import {
  checkIdTokenClaims,
  decodeJwtPayload,
  exchangeCode,
  fetchUserinfo,
  getDiscovery,
  isGroupAllowed,
  statesMatch,
} from '../../utils/oidc'

const log = createLog('auth')

/** Browsers refuse cookies over 4096 bytes. Past this the ID token (only a logout hint) is dropped. */
const MAX_COOKIE_VALUE = 3600

const retry = { href: '/auth/login', label: 'Try again' }

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export default defineEventHandler(async (event) => {
  if (!oidc) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const query = getQuery(event)
  const flow = (() => {
    const sealed = readCookie(getRequestHeader(event, 'cookie'), FLOW_COOKIE)
    return sealed ? unseal<AuthFlow>(sealed, oidc.sessionSecret, 'flow') : null
  })()
  // One attempt, one use: the flow cookie goes whatever happens next.
  clearAuthCookie(event, FLOW_COOKIE)

  if (typeof query['error'] === 'string') {
    log.warn('provider returned an error:', query['error'])
    return authPage(event, 400, 'Sign-in failed', 'The identity provider refused the sign-in.', retry)
  }
  if (!flow || !statesMatch(flow.state, query['state']) || typeof query['code'] !== 'string') {
    return authPage(event, 400, 'Sign-in expired', 'This sign-in attempt is no longer valid.', retry)
  }

  let session: AuthSession
  let idToken: string
  try {
    const discovery = await getDiscovery(oidc)
    const tokens = await exchangeCode(discovery, oidc, query['code'], flow.verifier)
    idToken = tokens.idToken

    const claims = decodeJwtPayload(idToken)
    const problem = claims
      ? checkIdTokenClaims(claims, { issuer: oidc.issuer, clientId: oidc.clientId, nonce: flow.nonce })
      : 'unreadable id token'
    if (!claims || problem) throw new Error(problem ?? 'unreadable id token')

    const info = await fetchUserinfo(discovery, tokens.accessToken)
    if (info['sub'] !== claims['sub']) throw new Error('userinfo sub does not match the id token')

    const groups = Array.isArray(info['groups']) ? info['groups'] : (claims['groups'] ?? [])
    if (!isGroupAllowed(groups, oidc.allowedGroups)) {
      log.warn(`denied ${str(info['email']) || str(info['sub'])}: not in an allowed group`)
      return authPage(event, 403, 'No access', "You don't have access to Butler.", {
        href: '/auth/logout',
        label: 'Sign out',
      })
    }

    session = {
      sub: str(info['sub']),
      name: str(info['name']) || str(info['preferred_username']) || str(info['email']),
      email: str(info['email']),
      groups: Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [],
      exp: Date.now() + SESSION_TTL_MS,
    }
  } catch (err) {
    log.fail('callback failed:', err)
    return authPage(event, 502, 'Sign-in failed', 'Something went wrong while signing you in.', retry)
  }

  let sealed = seal({ ...session, idt: idToken }, oidc.sessionSecret, 'session', SESSION_TTL_MS)
  if (sealed.length > MAX_COOKIE_VALUE) sealed = seal(session, oidc.sessionSecret, 'session', SESSION_TTL_MS)

  setCookie(event, SESSION_COOKIE, sealed, authCookieOptions(SESSION_TTL_MS))
  return sendRedirect(event, flow.ret, 302)
})
