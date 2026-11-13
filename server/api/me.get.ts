import { oidc } from '../utils/config'

export default defineEventHandler((event) => {
  const session = getAuthSession(event)
  return { enabled: oidc !== null, name: session?.name || session?.email || null }
})
