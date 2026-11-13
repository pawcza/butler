import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { OidcSettings } from './oidc-config'

export interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  end_session_endpoint?: string
  token_endpoint_auth_methods_supported?: string[]
}

export const SCOPES = 'openid profile email'

const DISCOVERY_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

/**
 * Only a same-origin relative path may be a post-login destination. Anything else becomes `/`.
 * Browsers strip tabs and newlines and read `\` as `/`, so those count as `//host` tricks too.
 */
export function sanitizeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return '/'
  try {
    const url = new URL(raw, 'http://butler.invalid')
    if (url.origin !== 'http://butler.invalid') return '/'
    if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) return '/'
    return url.pathname + url.search
  } catch {
    return '/'
  }
}

/** Empty `allowed` means any authenticated user. */
export function isGroupAllowed(groups: unknown, allowed: string[]): boolean {
  if (allowed.length === 0) return true
  if (!Array.isArray(groups)) return false
  return groups.some((group) => typeof group === 'string' && allowed.includes(group))
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(32)
  return { verifier, challenge: pkceChallenge(verifier) }
}

/** Constant-time comparison for the returned `state`. */
export function statesMatch(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

// `prompt=login` is deliberately never sent: it breaks social logins on Authentik 2025.8.1.
export function buildAuthorizeUrl(
  discovery: Discovery,
  oidc: OidcSettings,
  params: { state: string; nonce: string; challenge: string },
): string {
  const url = new URL(discovery.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', oidc.clientId)
  url.searchParams.set('redirect_uri', oidc.redirectUri)
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('state', params.state)
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('code_challenge', params.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/** Basic when the provider allows it (the OIDC default), POST body otherwise. */
export function buildTokenRequest(
  discovery: Discovery,
  oidc: OidcSettings,
  code: string,
  verifier: string,
): { url: string; init: RequestInit } {
  const methods = discovery.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
  const useBasic = methods.includes('client_secret_basic') || !methods.includes('client_secret_post')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: oidc.redirectUri,
    code_verifier: verifier,
  })
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  if (useBasic) {
    const credentials = `${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(oidc.clientSecret)}`
    headers['authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`
  } else {
    body.set('client_id', oidc.clientId)
    body.set('client_secret', oidc.clientSecret)
  }
  return { url: discovery.token_endpoint, init: { method: 'POST', headers, body } }
}

export function buildLogoutUrl(discovery: Discovery, oidc: OidcSettings, idToken?: string): string | null {
  if (!discovery.end_session_endpoint) return null
  const url = new URL(discovery.end_session_endpoint)
  if (idToken) url.searchParams.set('id_token_hint', idToken)
  url.searchParams.set('client_id', oidc.clientId)
  url.searchParams.set('post_logout_redirect_uri', `${oidc.origin}/`)
  return url.toString()
}

export type IdTokenClaims = Record<string, unknown>

export function decodeJwtPayload(jwt: string): IdTokenClaims | null {
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    return typeof claims === 'object' && claims !== null ? (claims as IdTokenClaims) : null
  } catch {
    return null
  }
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

/**
 * The ID token comes straight from the token endpoint over TLS, so its signature is not checked
 * (OIDC Core 3.1.3.7). Issuer, audience, expiry and nonce still are. Returns a reason on failure.
 */
export function checkIdTokenClaims(
  claims: IdTokenClaims,
  expected: { issuer: string; clientId: string; nonce: string },
  now = Date.now(),
): string | null {
  if (typeof claims['iss'] !== 'string' || trimSlash(claims['iss']) !== trimSlash(expected.issuer)) {
    return 'issuer mismatch'
  }
  const aud = claims['aud']
  const audiences = Array.isArray(aud) ? aud : [aud]
  if (!audiences.includes(expected.clientId)) return 'audience mismatch'
  if (typeof claims['exp'] !== 'number' || claims['exp'] * 1000 <= now) return 'id token expired'
  if (typeof claims['nonce'] !== 'string' || !statesMatch(expected.nonce, claims['nonce'])) return 'nonce mismatch'
  if (typeof claims['sub'] !== 'string' || claims['sub'] === '') return 'missing sub'
  return null
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}`)
  return res.json()
}

function parseDiscovery(raw: unknown, oidc: OidcSettings): Discovery {
  const d = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'userinfo_endpoint']) {
    if (typeof d[key] !== 'string') throw new Error(`discovery document has no ${key}`)
  }
  if (trimSlash(d['issuer'] as string) !== trimSlash(oidc.issuer)) {
    throw new Error(`discovery issuer ${String(d['issuer'])} does not match OIDC_ISSUER`)
  }
  const methods = d['token_endpoint_auth_methods_supported']
  const endSession = d['end_session_endpoint']
  return {
    issuer: d['issuer'] as string,
    authorization_endpoint: d['authorization_endpoint'] as string,
    token_endpoint: d['token_endpoint'] as string,
    userinfo_endpoint: d['userinfo_endpoint'] as string,
    ...(typeof endSession === 'string' ? { end_session_endpoint: endSession } : {}),
    ...(Array.isArray(methods)
      ? { token_endpoint_auth_methods_supported: methods.filter((m): m is string => typeof m === 'string') }
      : {}),
  }
}

let cached: { at: number; issuer: string; value: Discovery } | null = null

export async function getDiscovery(oidc: OidcSettings, now = Date.now()): Promise<Discovery> {
  if (cached && cached.issuer === oidc.issuer && now - cached.at < DISCOVERY_TTL_MS) return cached.value
  const raw = await fetchJson(`${oidc.issuer}.well-known/openid-configuration`)
  const value = parseDiscovery(raw, oidc)
  cached = { at: now, issuer: oidc.issuer, value }
  return value
}

export interface TokenResponse {
  accessToken: string
  idToken: string
}

export async function exchangeCode(
  discovery: Discovery,
  oidc: OidcSettings,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const { url, init } = buildTokenRequest(discovery, oidc, code, verifier)
  const raw = (await fetchJson(url, init)) as Record<string, unknown> | null
  const accessToken = raw?.['access_token']
  const idToken = raw?.['id_token']
  if (typeof accessToken !== 'string' || typeof idToken !== 'string') {
    throw new Error('token response is missing access_token or id_token')
  }
  return { accessToken, idToken }
}

export async function fetchUserinfo(discovery: Discovery, accessToken: string): Promise<IdTokenClaims> {
  const raw = await fetchJson(discovery.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  })
  if (typeof raw !== 'object' || raw === null) throw new Error('userinfo is not an object')
  return raw as IdTokenClaims
}
