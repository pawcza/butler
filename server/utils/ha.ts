import WebSocket from 'ws'
import { z } from 'zod'

const log = createLog('ha')

export async function haFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)

  let response: Response
  try {
    response = await fetch(`${config.HA_URL}/api${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.HA_TOKEN}`,
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`HA request timed out after 15s on ${path}`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }

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
    log.ok(`Exposed entity list: ${entries.length} entities`)
  } catch (err) {
    log.warn(`Failed to refresh entity list: ${err instanceof Error ? err.message : err}`)
  }
}

export function getEntityList(): string {
  return entityCache || 'No entities loaded yet.'
}

// ── Direct HA tool execution ─────────────────────────────────────────────────

const HA_TOOL_NAMES = new Set([
  'ha_call_service',
  'ha_bulk_control',
  'ha_get_state',
  'ha_config_get_calendar_events',
  'ha_config_set_calendar_event',
  'ha_get_todo',
  'ha_add_todo_item',
])

export function isHaTool(name: string): boolean {
  return HA_TOOL_NAMES.has(name)
}

interface HaBulkOp {
  domain: string
  service: string
  entity_id: string
  data?: Record<string, unknown>
}

interface HaCalendarEvent {
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  description?: string
  location?: string
}

interface HaTodoItem {
  summary?: string
  status?: string
  uid?: string
}

// ── Zod schemas for HA tool parameters ──────────────────────────────────────

const haCallServiceSchema = z.object({
  domain: z.string(),
  service: z.string(),
  entity_id: z.string(),
  data: z.record(z.unknown()).optional(),
})

const haBulkControlSchema = z.object({
  operations: z.array(z.object({
    domain: z.string(),
    service: z.string(),
    entity_id: z.string(),
    data: z.record(z.unknown()).optional(),
  })),
})

const haGetStateSchema = z.object({
  entity_id: z.string(),
})

const haGetCalendarEventsSchema = z.object({
  entity_id: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
})

const haSetCalendarEventSchema = z.object({
  entity_id: z.string(),
  summary: z.string(),
  start: z.string(),
  end: z.string(),
})

const haGetTodoSchema = z.object({
  entity_id: z.string(),
})

const haAddTodoItemSchema = z.object({
  entity_id: z.string(),
  summary: z.string(),
})

function formatValidationError(toolName: string, error: z.ZodError): string {
  const issues = error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')
  return `${toolName} validation failed: ${issues}`
}

async function routeHaTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'ha_call_service': {
      const parsed = haCallServiceSchema.safeParse(args)
      if (!parsed.success) return formatValidationError(name, parsed.error)
      const { domain, service, entity_id, data } = parsed.data
      await haFetch(`/services/${domain}/${service}`, {
        method: 'POST',
        body: JSON.stringify({ entity_id, ...(data ?? {}) }),
      })
      return 'OK'
    }

    case 'ha_bulk_control': {
      const parsed = haBulkControlSchema.safeParse(args)
      if (!parsed.success) return formatValidationError(name, parsed.error)
      const results = await Promise.all(
        parsed.data.operations.map(async (op) => {
          try {
            await haFetch(`/services/${op.domain}/${op.service}`, {
              method: 'POST',
              body: JSON.stringify({ entity_id: op.entity_id, ...(op.data ?? {}) }),
            })
            return `${op.entity_id}: OK`
          } catch (err) {
            return `${op.entity_id}: Error — ${err instanceof Error ? err.message : err}`
          }
        }),
      )
      return results.join('\n')
    }

    case 'ha_get_state': {
      const parsed = haGetStateSchema.safeParse(args)
      if (!parsed.success) return formatValidationError(name, parsed.error)
      const state = await haFetch<HaState>(`/states/${parsed.data.entity_id}`)
      const attrs = state.attributes as Record<string, unknown>
      const lines = [`${state.entity_id}: ${state.state}`]
      if (attrs['friendly_name']) lines.push(`  name: ${attrs['friendly_name']}`)
      if (attrs['brightness'] !== undefined) lines.push(`  brightness: ${attrs['brightness']}`)
      if (attrs['temperature'] !== undefined) lines.push(`  temperature: ${attrs['temperature']}`)
      if (attrs['current_temperature'] !== undefined) lines.push(`  current_temperature: ${attrs['current_temperature']}`)
      if (attrs['unit_of_measurement']) lines.push(`  unit: ${attrs['unit_of_measurement']}`)
      return lines.join('\n')
    }

    case 'ha_config_get_calendar_events': {
      const parsed = haGetCalendarEventsSchema.safeParse(args)
      if (!parsed.success) return formatValidationError(name, parsed.error)
      const { entity_id, start, end } = parsed.data
      const startStr = start ?? new Date().toISOString()
      const endStr = end ?? new Date(Date.now() + 7 * 86400000).toISOString()
      const events = await haFetch<HaCalendarEvent[]>(
        `/calendars/${entity_id}?start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}`,
      )
      if (events.length === 0) return 'No events found.'
      return events.map((e) => {
        const when = e.start?.dateTime ?? e.start?.date ?? '?'
        return `- ${e.summary ?? '(no title)'} @ ${when}`
      }).join('\n')
    }

    case 'ha_config_set_calendar_event': {
      const parsed = haSetCalendarEventSchema.safeParse(args)
      if (!parsed.success) return formatValidationError(name, parsed.error)
      const { entity_id, summary, start, end } = parsed.data
      await haFetch('/services/calendar/create_event', {
        method: 'POST',
        body: JSON.stringify({
          entity_id,
          summary,
          start_date_time: start,
          end_date_time: end,
        }),
      })
      return 'OK'
    }

    case 'ha_get_todo': {
      const parsed = haGetTodoSchema.safeParse(args)
      if (!parsed.success) return formatValidationError(name, parsed.error)
      const { entity_id } = parsed.data
      const result = await haFetch<{ response: Record<string, { items: HaTodoItem[] }> }>(
        '/services/todo/get_items?return_response',
        {
          method: 'POST',
          body: JSON.stringify({ entity_id, return_response: true }),
        },
      )
      const items = result.response[entity_id]?.items ?? []
      if (items.length === 0) return 'No items.'
      return items.map((i) => `- [${i.status === 'completed' ? 'x' : ' '}] ${i.summary ?? '?'}`).join('\n')
    }

    case 'ha_add_todo_item': {
      const parsed = haAddTodoItemSchema.safeParse(args)
      if (!parsed.success) return formatValidationError(name, parsed.error)
      const { entity_id, summary } = parsed.data
      await haFetch('/services/todo/add_item', {
        method: 'POST',
        body: JSON.stringify({ entity_id, item: summary }),
      })
      return 'OK'
    }

    default:
      return `Error: Unknown HA tool "${name}"`
  }
}

export async function executeHaTool(name: string, args: Record<string, unknown>): Promise<string> {
  const t0 = Date.now()
  log.info(`→ ${name} | args: ${JSON.stringify(args)}`)
  try {
    const result = await routeHaTool(name, args)
    log.ok(`${name} (${Date.now() - t0}ms)`)
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.fail(`${name} (${Date.now() - t0}ms) — ${msg}`)
    return `Error: ${msg}`
  }
}
