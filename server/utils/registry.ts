import type { ButlerTool, OllamaTool } from '~/shared/types'

const log = createLog('registry')

/**
 * All voice tool definitions — lean schemas purpose-built for the LLM.
 * HA tools execute via direct REST calls; butler tools execute locally.
 */
const VOICE_TOOLS: ButlerTool[] = [
  // ── HA tools (executed via direct REST) ─────────────────────────────────────
  {
    name: 'ha_call_service',
    description: 'Control a single HA entity.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        service: { type: 'string' },
        entity_id: { type: 'string' },
        data: { type: 'object', description: 'Service-specific params (e.g. brightness, temperature)' },
      },
      required: ['domain', 'service', 'entity_id'],
    },
  },
  {
    name: 'ha_bulk_control',
    description: 'Control multiple HA entities at once.',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of {domain, service, entity_id, data} objects',
        },
      },
      required: ['operations'],
    },
  },
  {
    name: 'ha_get_state',
    description: 'Read current state of an HA entity.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'ha_config_get_calendar_events',
    description: 'Get calendar events in a date range.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        start: { type: 'string', description: 'ISO datetime' },
        end: { type: 'string', description: 'ISO datetime' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'ha_config_set_calendar_event',
    description: 'Create a calendar event.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        summary: { type: 'string' },
        start: { type: 'string', description: 'ISO datetime' },
        end: { type: 'string', description: 'ISO datetime' },
      },
      required: ['entity_id', 'summary', 'start', 'end'],
    },
  },
  {
    name: 'ha_get_todo',
    description: 'Get items from a todo/shopping list.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'ha_add_todo_item',
    description: 'Add an item to a todo/shopping list.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['entity_id', 'summary'],
    },
  },
  // ── Butler tools (executed locally) ─────────────────────────────────────────
  {
    name: 'timer_start',
    description: 'Start a countdown timer.',
    parameters: {
      type: 'object',
      properties: {
        duration_seconds: { type: 'number', description: 'Duration in seconds' },
        label: { type: 'string', description: 'Optional label' },
      },
      required: ['duration_seconds'],
    },
  },
  {
    name: 'timer_stop',
    description: 'Cancel an active timer.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Timer label to cancel. Omit to cancel all.' },
      },
    },
  },
  {
    name: 'timer_check',
    description: 'Check remaining time on active timers.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Timer label. Omit to list all.' },
      },
    },
  },
  {
    name: 'news_briefing',
    description: 'Fetch latest news headlines.',
    parameters: { type: 'object', properties: {} },
  },
]

const BUILTIN_NAMES = new Set(['timer_start', 'timer_stop', 'timer_check', 'news_briefing'])

let cachedTools: OllamaTool[] = []

export function buildRegistry(): void {
  cachedTools = VOICE_TOOLS.map((t): OllamaTool => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  const totalSize = JSON.stringify(cachedTools).length
  log.ok(`${cachedTools.length} voice tools cached (${(totalSize / 1024).toFixed(1)}KB)`)
}

export function isBuiltInTool(name: string): boolean {
  return BUILTIN_NAMES.has(name)
}

export function rebuildToolCache(): void {
  cachedTools = VOICE_TOOLS.map((t): OllamaTool => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  log.ok(`Tool cache rebuilt: ${cachedTools.length} tools`)
}

export function getOllamaTools(): OllamaTool[] {
  return cachedTools
}
