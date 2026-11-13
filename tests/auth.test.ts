import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  SESSION_COOKIE,
  readCookie,
  seal,
  sessionFromCookieHeader,
  unseal,
  type AuthSession,
} from '../server/utils/auth-cookie'
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  buildTokenRequest,
  checkIdTokenClaims,
  createPkce,
  decodeJwtPayload,
  isGroupAllowed,
  pkceChallenge,
  sanitizeReturnPath,
  statesMatch,
  type Discovery,
} from '../server/utils/oidc'
import { oidcShape, refineOidc, resolveOidc, type OidcSettings } from '../server/utils/oidc-config'

const schema = z.object(oidcShape).superRefine(refineOidc)
const SECRET = 'x'.repeat(40)

const fullEnv = {
  OIDC_ISSUER: 'https://auth.example.com/application/o/butler/',
  OIDC_CLIENT_ID: 'butler',
  OIDC_CLIENT_SECRET: 'shh',
  OIDC_REDIRECT_URI: 'https://butler.example.com/auth/callback',
  OIDC_ALLOWED_GROUPS: 'owners, family ,',
  SESSION_SECRET: SECRET,
}

const settings: OidcSettings = {
  issuer: 'https://auth.example.com/application/o/butler/',
  clientId: 'butler',
  clientSecret: 'p@ss:word',
  redirectUri: 'https://butler.example.com/auth/callback',
  origin: 'https://butler.example.com',
  secure: true,
  allowedGroups: ['owners'],
  sessionSecret: SECRET,
}

const discovery: Discovery = {
  issuer: settings.issuer,
  authorization_endpoint: 'https://auth.example.com/application/o/authorize/',
  token_endpoint: 'https://auth.example.com/application/o/token/',
  userinfo_endpoint: 'https://auth.example.com/application/o/userinfo/',
  end_session_endpoint: 'https://auth.example.com/application/o/butler/end-session/',
}

describe('oidc env validation', () => {
  it('leaves auth off when nothing is set', () => {
    const parsed = schema.parse({})
    expect(resolveOidc(parsed)).toBeNull()
  })

  it('accepts a complete set and derives origin, secure flag and groups', () => {
    const oidc = resolveOidc(schema.parse(fullEnv))
    expect(oidc).toMatchObject({
      origin: 'https://butler.example.com',
      secure: true,
      allowedGroups: ['owners', 'family'],
    })
  })

  it('adds the trailing slash the discovery URL needs', () => {
    const parsed = schema.parse({ ...fullEnv, OIDC_ISSUER: 'https://auth.example.com/application/o/butler' })
    expect(parsed.OIDC_ISSUER).toBe('https://auth.example.com/application/o/butler/')
  })

  it('treats an http redirect URI as not secure', () => {
    const oidc = resolveOidc(schema.parse({ ...fullEnv, OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback' }))
    expect(oidc?.secure).toBe(false)
    expect(oidc?.origin).toBe('http://localhost:3000')
  })

  it('allows an empty group list', () => {
    const { OIDC_ALLOWED_GROUPS: _omit, ...rest } = fullEnv
    expect(resolveOidc(schema.parse(rest))?.allowedGroups).toEqual([])
  })

  it.each(['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'SESSION_SECRET'] as const)(
    'rejects an issuer without %s',
    (key) => {
      const { [key]: _omit, ...rest } = fullEnv
      const result = schema.safeParse(rest)
      expect(result.success).toBe(false)
      expect(result.error?.errors.map((e) => e.path.join('.'))).toContain(key)
    },
  )

  it('rejects a short session secret', () => {
    const result = schema.safeParse({ ...fullEnv, SESSION_SECRET: 'too-short' })
    expect(result.success).toBe(false)
    expect(result.error?.errors[0]?.message).toMatch(/32/)
  })

  it('rejects OIDC settings without an issuer rather than running open', () => {
    const result = schema.safeParse({ OIDC_CLIENT_ID: 'butler', OIDC_ALLOWED_GROUPS: 'owners' })
    expect(result.success).toBe(false)
    expect(result.error?.errors.map((e) => e.path.join('.'))).toEqual(['OIDC_CLIENT_ID', 'OIDC_ALLOWED_GROUPS'])
  })
})

describe('sanitizeReturnPath', () => {
  it.each([
    ['/', '/'],
    ['/c?c=abc', '/c?c=abc'],
    ['/?c=abc&x=1', '/?c=abc&x=1'],
    ['/deep/path', '/deep/path'],
  ])('keeps %s', (input, expected) => {
    expect(sanitizeReturnPath(input)).toBe(expected)
  })

  it.each([
    undefined,
    null,
    42,
    ['/a'],
    '',
    'https://evil.example',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    'evil.example',
    'javascript:alert(1)',
    '/auth/logout',
    '/auth/login?return=/',
    '/' + 'a'.repeat(3000),
  ])('falls back to / for %j', (input) => {
    expect(sanitizeReturnPath(input)).toBe('/')
  })
})

describe('isGroupAllowed', () => {
  it('admits anyone when no group is required', () => {
    expect(isGroupAllowed(undefined, [])).toBe(true)
    expect(isGroupAllowed([], [])).toBe(true)
  })

  it('needs one matching group', () => {
    expect(isGroupAllowed(['family', 'owners'], ['owners'])).toBe(true)
    expect(isGroupAllowed(['family'], ['owners'])).toBe(false)
    expect(isGroupAllowed([], ['owners'])).toBe(false)
  })

  it('denies a missing or malformed groups claim', () => {
    expect(isGroupAllowed(undefined, ['owners'])).toBe(false)
    expect(isGroupAllowed('owners', ['owners'])).toBe(false)
    expect(isGroupAllowed([{ name: 'owners' }], ['owners'])).toBe(false)
  })

  it('matches exact names only', () => {
    expect(isGroupAllowed(['owners-extra', 'Owners'], ['owners'])).toBe(false)
  })
})

describe('PKCE and state', () => {
  it('derives the S256 challenge from the verifier', () => {
    // RFC 7636 appendix B
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('makes a fresh verifier within the RFC length, matching its challenge', () => {
    const a = createPkce()
    const b = createPkce()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.verifier.length).toBeGreaterThanOrEqual(43)
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'))
  })

  it('compares states exactly', () => {
    expect(statesMatch('abc', 'abc')).toBe(true)
    expect(statesMatch('abc', 'abd')).toBe(false)
    expect(statesMatch('abc', 'abcd')).toBe(false)
    expect(statesMatch('abc', undefined)).toBe(false)
    expect(statesMatch('abc', ['abc'])).toBe(false)
  })
})

describe('authorize and logout URLs', () => {
  it('asks for code + PKCE + state + nonce with the three scopes, and never prompt=login', () => {
    const url = new URL(buildAuthorizeUrl(discovery, settings, { state: 's1', nonce: 'n1', challenge: 'c1' }))
    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'butler',
      redirect_uri: settings.redirectUri,
      scope: 'openid profile email',
      state: 's1',
      nonce: 'n1',
      code_challenge: 'c1',
      code_challenge_method: 'S256',
    })
    expect(url.searchParams.has('prompt')).toBe(false)
  })

  it('logs out with the hint and returns to the app origin', () => {
    const url = new URL(buildLogoutUrl(discovery, settings, 'id.token.here') ?? '')
    expect(url.searchParams.get('id_token_hint')).toBe('id.token.here')
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://butler.example.com/')
  })

  it('has no logout redirect without an end-session endpoint', () => {
    const { end_session_endpoint: _omit, ...bare } = discovery
    expect(buildLogoutUrl(bare, settings)).toBeNull()
  })
})

describe('token request', () => {
  const header = (init: RequestInit) => (init.headers as Record<string, string>)['authorization']

  it('uses client_secret_basic by default, with form-encoded credentials', () => {
    const { url, init } = buildTokenRequest(discovery, settings, 'the-code', 'the-verifier')
    expect(url).toBe(discovery.token_endpoint)
    const expected = Buffer.from(`butler:${encodeURIComponent('p@ss:word')}`).toString('base64')
    expect(header(init)).toBe(`Basic ${expected}`)
    const body = init.body as URLSearchParams
    expect(body.get('code')).toBe('the-code')
    expect(body.get('code_verifier')).toBe('the-verifier')
    expect(body.get('redirect_uri')).toBe(settings.redirectUri)
    expect(body.has('client_secret')).toBe(false)
  })

  it('falls back to client_secret_post when Basic is not offered', () => {
    const { init } = buildTokenRequest(
      { ...discovery, token_endpoint_auth_methods_supported: ['client_secret_post'] },
      settings,
      'c',
      'v',
    )
    expect(header(init)).toBeUndefined()
    const body = init.body as URLSearchParams
    expect(body.get('client_id')).toBe('butler')
    expect(body.get('client_secret')).toBe('p@ss:word')
  })
})

describe('id token claims', () => {
  const now = 1_700_000_000_000
  const expected = { issuer: settings.issuer, clientId: 'butler', nonce: 'n1' }
  const good = { iss: settings.issuer, aud: 'butler', exp: now / 1000 + 60, nonce: 'n1', sub: 'u1' }

  it('accepts a matching token, with the issuer slash either way', () => {
    expect(checkIdTokenClaims(good, expected, now)).toBeNull()
    expect(checkIdTokenClaims({ ...good, iss: settings.issuer.slice(0, -1) }, expected, now)).toBeNull()
    expect(checkIdTokenClaims({ ...good, aud: ['other', 'butler'] }, expected, now)).toBeNull()
  })

  it.each([
    ['issuer', { iss: 'https://evil.example/' }],
    ['audience', { aud: 'someone-else' }],
    ['expired', { exp: now / 1000 - 1 }],
    ['nonce', { nonce: 'replayed' }],
    ['sub', { sub: '' }],
  ])('rejects a bad %s', (_name, patch) => {
    expect(checkIdTokenClaims({ ...good, ...patch }, expected, now)).not.toBeNull()
  })

  it('decodes the payload of a JWT and refuses junk', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')
    expect(decodeJwtPayload(`aaa.${payload}.zzz`)).toEqual({ sub: 'u1' })
    expect(decodeJwtPayload('nope')).toBeNull()
    expect(decodeJwtPayload('a.!!!.c')).toBeNull()
  })
})

describe('sealed cookies', () => {
  const now = 1_700_000_000_000
  const session: AuthSession = {
    sub: 'u1',
    name: 'Owner',
    email: 'o@example.com',
    groups: ['owners'],
    exp: now + 1000,
  }

  it('round-trips a payload', () => {
    const sealed = seal({ a: 1 }, SECRET, 'flow', 1000, now)
    expect(unseal(sealed, SECRET, 'flow', now)).toEqual({ a: 1 })
  })

  it('does not leak the payload', () => {
    const sealed = seal({ secretValue: 'hunter2' }, SECRET, 'flow', 1000, now)
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain('hunter2')
  })

  it('refuses a tampered cookie, a wrong secret, another purpose and an expired one', () => {
    const sealed = seal({ a: 1 }, SECRET, 'flow', 1000, now)
    const flipped = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA')
    expect(unseal(flipped, SECRET, 'flow', now)).toBeNull()
    expect(unseal(sealed, 'y'.repeat(40), 'flow', now)).toBeNull()
    expect(unseal(sealed, SECRET, 'session', now)).toBeNull()
    expect(unseal(sealed, SECRET, 'flow', now + 1000)).toBeNull()
    expect(unseal('not-a-cookie', SECRET, 'flow', now)).toBeNull()
    expect(unseal('', SECRET, 'flow', now)).toBeNull()
  })

  it('reads one cookie out of a header', () => {
    expect(readCookie('a=1; butler_session=abc; b=2', 'butler_session')).toBe('abc')
    expect(readCookie('a=1', 'butler_session')).toBeNull()
    expect(readCookie(null, 'butler_session')).toBeNull()
  })

  it('finds a valid session from a Cookie header', () => {
    const sealed = seal(session, SECRET, 'session', 1000, now)
    expect(sessionFromCookieHeader(`x=1; ${SESSION_COOKIE}=${sealed}`, SECRET, now)).toEqual(session)
  })

  it('does not accept a flow cookie, an expired session or no cookie as a session', () => {
    const asFlow = seal(session, SECRET, 'flow', 1000, now)
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=${asFlow}`, SECRET, now)).toBeNull()

    const stale = seal({ ...session, exp: now - 1 }, SECRET, 'session', 1000, now)
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=${stale}`, SECRET, now)).toBeNull()

    expect(sessionFromCookieHeader(null, SECRET, now)).toBeNull()
    expect(sessionFromCookieHeader('other=1', SECRET, now)).toBeNull()
  })
})
