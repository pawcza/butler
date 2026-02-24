import WebSocket from 'ws'

export async function haFetch<T>(path: string, options?: RequestInit): Promise<T> {
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

// ── Exposed entity list for LLM context ──────────────────────────────────────

let entityCache = ''

interface HaState {
  entity_id: string
  state: string
  attributes: { friendly_name?: string }
}

/**
 * One-shot HA WebSocket call: authenticate, send command, return result, close.
 */
async function haWsCall<T>(command: Record<string, unknown>): Promise<T> {
  const wsUrl = config.HA_URL.replace(/^http/, 'ws') + '/api/websocket'
  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let msgId = 1
    const timeout = setTimeout(() => { ws.close(); reject(new Error('HA WS timeout')) }, 10_000)

    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { type: string; id?: number; result?: T }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: config.HA_TOKEN }))
      } else if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ id: msgId, ...command }))
      } else if (msg.type === 'auth_invalid') {
        clearTimeout(timeout); ws.close(); reject(new Error('HA WS auth failed'))
      } else if (msg.type === 'result' && msg.id === msgId) {
        clearTimeout(timeout); ws.close(); resolve(msg.result as T)
      }
    })

    ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err) })
  })
}

/**
 * Fetch entities exposed to the conversation assistant (Voice Assistants → Expose).
 * Uses HA's WebSocket API — the only way to read exposure settings.
 */
export async function refreshEntityList(): Promise<void> {
  try {
    // Step 1: Get exposed entity IDs via WS
    const exposed = await haWsCall<{ exposed_entities: Record<string, Record<string, boolean>> }>(
      { type: 'homeassistant/expose_entity/list' },
    )

    const conversationEntityIds = new Set<string>()
    for (const [entityId, assistants] of Object.entries(exposed.exposed_entities)) {
      if (assistants['conversation']) {
        conversationEntityIds.add(entityId)
      }
    }

    // Step 2: Get states for friendly names (REST — single call)
    const states = await haFetch<HaState[]>('/states')
    const stateMap = new Map<string, HaState>()
    for (const s of states) {
      stateMap.set(s.entity_id, s)
    }

    // Step 3: Build entity list
    const entries: string[] = []
    for (const entityId of conversationEntityIds) {
      const state = stateMap.get(entityId)
      const name = state?.attributes.friendly_name ?? entityId
      entries.push(`${entityId} "${name}"`)
    }

    entityCache = entries.join('\n')
    console.log(`[ha] Exposed entity list: ${entries.length} entities`)
  } catch (err) {
    console.warn(`[ha] Failed to refresh entity list: ${err instanceof Error ? err.message : err}`)
  }
}

export function getEntityList(): string {
  return entityCache
}
