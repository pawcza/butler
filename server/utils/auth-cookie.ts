import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export const SESSION_COOKIE = 'butler_session'
export const FLOW_COOKIE = 'butler_oidc'
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const FLOW_TTL_MS = 10 * 60 * 1000

export interface AuthSession {
  sub: string
  name: string
  email: string
  groups: string[]
  /** Epoch ms. */
  exp: number
  /** Kept for `id_token_hint` at logout. Left out when it would push the cookie past the size limit. */
  idt?: string
}

/** The short-lived cookie that carries a login attempt from /auth/login to /auth/callback. */
export interface AuthFlow {
  state: string
  verifier: string
  nonce: string
  /** Same-origin relative path to land on after login. */
  ret: string
}

const IV_BYTES = 12
const TAG_BYTES = 16

function keyFor(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'butler-auth-v1', purpose, 32))
}

/**
 * AES-256-GCM, with a key derived per purpose so a flow cookie can never be replayed as a session.
 * The expiry lives inside the sealed payload, not just in the cookie attributes.
 */
export function seal(payload: unknown, secret: string, purpose: string, ttlMs: number, now = Date.now()): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv)
  cipher.setAAD(Buffer.from(purpose))
  const body = Buffer.from(JSON.stringify({ p: payload, exp: now + ttlMs }))
  const ct = Buffer.concat([cipher.update(body), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')
}

/** `null` for anything tampered, expired, sealed for another purpose, or malformed. */
export function unseal<T>(sealed: string, secret: string, purpose: string, now = Date.now()): T | null {
  try {
    const raw = Buffer.from(sealed, 'base64url')
    if (raw.length <= IV_BYTES + TAG_BYTES) return null
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, purpose), raw.subarray(0, IV_BYTES))
    decipher.setAAD(Buffer.from(purpose))
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    const body = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()])
    const envelope = JSON.parse(body.toString()) as { p?: unknown; exp?: unknown }
    if (typeof envelope.exp !== 'number' || envelope.exp <= now) return null
    return envelope.p as T
  } catch {
    return null
  }
}

/** One cookie out of a raw `Cookie` header. Sealed values are base64url, so no decoding is needed. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

function isSession(value: unknown): value is AuthSession {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s['sub'] === 'string' &&
    s['sub'] !== '' &&
    typeof s['exp'] === 'number' &&
    Array.isArray(s['groups'])
  )
}

/** The signed-in user for a raw `Cookie` header, or `null`. Used by the HTTP middleware and the WebSocket upgrade alike. */
export function sessionFromCookieHeader(
  header: string | null | undefined,
  secret: string,
  now = Date.now(),
): AuthSession | null {
  const sealed = readCookie(header, SESSION_COOKIE)
  if (!sealed) return null
  const session = unseal<unknown>(sealed, secret, 'session', now)
  if (!isSession(session) || session.exp <= now) return null
  return session
}
