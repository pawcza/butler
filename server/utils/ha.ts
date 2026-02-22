export interface HaState {
  entity_id: string
  state: string
  attributes: {
    friendly_name?: string
    [key: string]: unknown
  }
}

export interface HaDevice {
  id: string
  name: string | null
  name_by_user: string | null
  area_id: string | null
  manufacturer: string | null
  model: string | null
  disabled_by: string | null
}

export interface HaEntityEntry {
  entity_id: string
  device_id: string | null
  disabled_by: string | null
}

export interface HaArea {
  area_id: string
  name: string
}

export interface HaServiceCallParams {
  domain: string
  service: string
  entity_id?: string
  service_data?: Record<string, unknown>
}

// ── REST helper (states + service calls) ─────────────────────────────────────

async function haFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${config.HA_URL}/api${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.HA_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '(no body)')
    throw new Error(`HA API ${response.status} on ${path}: ${errBody}`)
  }

  return response.json() as Promise<T>
}

// ── WebSocket helper (config registry calls) ──────────────────────────────────
// The /api/config/*_registry/list REST endpoints were removed in modern HAOS.
// The WebSocket API is the current supported approach for registry access.

function haWsRequest<T>(type: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const wsUrl = config.HA_URL.replace(/^http/, 'ws') + '/api/websocket'
    const ws = new WebSocket(wsUrl)
    const cmdId = 1

    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`HA WebSocket timeout for "${type}"`))
    }, 10_000)

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>

      switch (msg['type']) {
        case 'auth_required':
          ws.send(JSON.stringify({ type: 'auth', access_token: config.HA_TOKEN }))
          break

        case 'auth_ok':
          ws.send(JSON.stringify({ id: cmdId, type }))
          break

        case 'auth_invalid':
          clearTimeout(timeout)
          ws.close()
          reject(new Error('HA WebSocket authentication failed'))
          break

        case 'result':
          if ((msg['id'] as number) === cmdId) {
            clearTimeout(timeout)
            ws.close()
            if (msg['success']) {
              resolve(msg['result'] as T)
            } else {
              reject(new Error(`HA WS "${type}" failed: ${JSON.stringify(msg['error'])}`))
            }
          }
          break
      }
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error(`HA WebSocket connection failed (${wsUrl})`))
    }
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getStates(): Promise<HaState[]> {
  return haFetch<HaState[]>('/states')
}

export async function getDevices(): Promise<HaDevice[]> {
  return haWsRequest<HaDevice[]>('config/device_registry/list')
}

export async function getEntityRegistry(): Promise<HaEntityEntry[]> {
  return haWsRequest<HaEntityEntry[]>('config/entity_registry/list')
}

export async function getAreas(): Promise<HaArea[]> {
  return haWsRequest<HaArea[]>('config/area_registry/list')
}

export async function callService(params: HaServiceCallParams): Promise<unknown> {
  const { domain, service, entity_id, service_data } = params
  const body = { entity_id, ...(service_data ?? {}) }
  console.log(`[ha] POST /services/${domain}/${service} — body: ${JSON.stringify(body)}`)
  return haFetch<unknown>(`/services/${domain}/${service}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
