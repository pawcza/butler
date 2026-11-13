import { z } from 'zod'

const withTrailingSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`)

/** The OIDC part of the env schema. All optional as a group: no `OIDC_ISSUER` means auth is off. */
export const oidcShape = {
  OIDC_ISSUER: z
    .string()
    .url('OIDC_ISSUER must be a valid URL')
    .transform(withTrailingSlash)
    .optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url('OIDC_REDIRECT_URI must be a valid URL').optional(),
  /** Comma-separated. Empty means any authenticated user. */
  OIDC_ALLOWED_GROUPS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((group) => group.trim())
        .filter(Boolean),
    ),
  SESSION_SECRET: z.string().optional(),
}

export type OidcEnv = z.output<z.ZodObject<typeof oidcShape>>

const GROUP_KEYS = [
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'OIDC_ALLOWED_GROUPS',
] as const

/** With OIDC on, the set must be complete. With it off, a stray OIDC_* var is a typo that would leave Butler open. */
export function refineOidc(env: OidcEnv, ctx: z.RefinementCtx): void {
  const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })

  if (!env.OIDC_ISSUER) {
    for (const key of GROUP_KEYS) {
      const value = env[key]
      const isSet = Array.isArray(value) ? value.length > 0 : value !== undefined
      if (isSet) fail(key, 'is set but OIDC_ISSUER is not, so login would silently stay off')
    }
    return
  }

  if (!env.OIDC_CLIENT_ID) fail('OIDC_CLIENT_ID', 'is required when OIDC_ISSUER is set')
  if (!env.OIDC_CLIENT_SECRET) fail('OIDC_CLIENT_SECRET', 'is required when OIDC_ISSUER is set')
  if (!env.OIDC_REDIRECT_URI) fail('OIDC_REDIRECT_URI', 'is required when OIDC_ISSUER is set')
  if (!env.SESSION_SECRET) fail('SESSION_SECRET', 'is required when OIDC_ISSUER is set')
  else if (env.SESSION_SECRET.length < 32) fail('SESSION_SECRET', 'must be at least 32 characters')
}

export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /** Origin of the redirect URI. Never derived from the Host header: Butler sits behind a proxy. */
  origin: string
  secure: boolean
  allowedGroups: string[]
  sessionSecret: string
}

/** `null` when auth is off. Throws when the set is incomplete, which `refineOidc` already rules out. */
export function resolveOidc(env: OidcEnv): OidcSettings | null {
  if (!env.OIDC_ISSUER) return null
  const { OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI, SESSION_SECRET } = env
  if (!OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !OIDC_REDIRECT_URI || !SESSION_SECRET) {
    throw new Error('OIDC settings are incomplete')
  }
  const redirect = new URL(OIDC_REDIRECT_URI)
  return {
    issuer: env.OIDC_ISSUER,
    clientId: OIDC_CLIENT_ID,
    clientSecret: OIDC_CLIENT_SECRET,
    redirectUri: OIDC_REDIRECT_URI,
    origin: redirect.origin,
    secure: redirect.protocol === 'https:',
    allowedGroups: env.OIDC_ALLOWED_GROUPS,
    sessionSecret: SESSION_SECRET,
  }
}
