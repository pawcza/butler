export interface HaState {
  entity_id: string
  state: string
  attributes: {
    friendly_name?: string
    [key: string]: unknown
  }
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

/**
 * Resolves area names for all entities via HA's template API in a single request.
 * Returns entity_id → area name (only entries that have an area assigned).
 */
export async function getEntityAreas(): Promise<Record<string, string>> {
  const template =
    '{% set ns = namespace(items=[]) %}' +
    '{% for s in states %}' +
    '{% set a = area_name(s.entity_id) %}' +
    '{% if a %}' +
    '{% set ns.items = ns.items + [{"e": s.entity_id, "a": a}] %}' +
    '{% endif %}' +
    '{% endfor %}' +
    '{{ ns.items | to_json }}'

  const response = await fetch(`${config.HA_URL}/api/template`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.HA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ template }),
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '(no body)')
    throw new Error(`HA template API ${response.status}: ${errBody}`)
  }

  const items = JSON.parse(await response.text()) as Array<{ e: string; a: string }>
  const map: Record<string, string> = {}
  for (const item of items) {
    map[item.e] = item.a
  }
  return map
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
