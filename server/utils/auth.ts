import type { H3Event } from 'h3'
import { SESSION_COOKIE, sessionFromCookieHeader, type AuthSession } from './auth-cookie'
import { oidc } from './config'

/** Cookie attributes shared by the session and the login-flow cookie. */
export function authCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: oidc?.secure ?? false,
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  }
}

export function clearAuthCookie(event: H3Event, name: string): void {
  const { maxAge: _maxAge, ...attributes } = authCookieOptions(0)
  deleteCookie(event, name, attributes)
}

/** The signed-in user, or `null`. Only meaningful when OIDC is on. */
export function getAuthSession(event: H3Event): AuthSession | null {
  if (!oidc) return null
  return sessionFromCookieHeader(getRequestHeader(event, 'cookie'), oidc.sessionSecret)
}


/** A plain page for the dead ends of login. Static text only: nothing user-controlled goes in. */
export function authPage(event: H3Event, status: number, title: string, body: string, link: { href: string; label: string }): string {
  setResponseStatus(event, status)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:14px ui-monospace,monospace;text-align:center}
main{max-width:28rem;padding:2rem}h1{color:#e5e7eb;letter-spacing:.25em;text-transform:uppercase;font-size:1.25rem}
a{color:#fff;letter-spacing:.1em;text-transform:uppercase;font-size:11px}p{opacity:.75}</style></head>
<body><main><h1>${title}</h1><p>${body}</p><a href="${link.href}">${link.label}</a></main></body></html>`
}
