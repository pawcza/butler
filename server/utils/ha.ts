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

export async function getStates(): Promise<HaState[]> {
  return haFetch<HaState[]>('/states')
}

export async function getDevices(): Promise<HaDevice[]> {
  return haFetch<HaDevice[]>('/config/device_registry/list')
}

export async function getEntityRegistry(): Promise<HaEntityEntry[]> {
  return haFetch<HaEntityEntry[]>('/config/entity_registry/list')
}

export async function getAreas(): Promise<HaArea[]> {
  return haFetch<HaArea[]>('/config/area_registry/list')
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
