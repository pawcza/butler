import type { ButlerTool, OllamaTool } from '~/shared/types'

const BUTLER_TOOLS: ButlerTool[] = [
  {
    name: 'timer_start',
    description: 'Start a countdown timer.',
    parameters: {
      type: 'object',
      properties: {
        duration_seconds: { type: 'number', description: 'Duration in seconds' },
        label: { type: 'string', description: 'Optional label for the timer' },
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
        label: { type: 'string', description: 'Timer label to cancel. Omit to cancel all timers.' },
      },
    },
  },
  {
    name: 'timer_check',
    description: 'Check remaining time on active timers.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Timer label to check. Omit to list all.' },
      },
    },
  },
  {
    name: 'news_briefing',
    description: 'Fetch latest world and tech news headlines.',
    parameters: { type: 'object', properties: {} },
  },
]

/**
 * MCP tools to expose to the LLM for voice commands.
 * qwen3:8b works best with ≤20 tools. The full ha-mcp set (~89) drowns the model.
 * All MCP tools remain callable via the text-extraction fallback — this only
 * limits what appears in the Ollama `tools` parameter.
 */
const VOICE_MCP_TOOLS = new Set([
  'ha_call_service',         // Control any entity (lights, switches, climate, media, etc.)
  'ha_get_state',            // Read a single entity's state
  'ha_get_states',           // Read multiple entity states
  'ha_search_entities',      // Find entities by name, area, or domain
  'ha_bulk_control',         // Control multiple entities at once
  'ha_get_bulk_status',      // Status of multiple entities
  'ha_config_list_areas',    // List rooms/areas
  'ha_config_get_calendar_events', // Read calendar events
  'ha_config_set_calendar_event',  // Create calendar events
  'ha_get_overview',         // Home overview
  'ha_get_history',          // Entity history
  'ha_get_todo',             // Read todo/shopping lists
  'ha_add_todo_item',        // Add to todo/shopping lists
])

export async function buildRegistry(): Promise<void> {
  await connectMcp()
  // DEBUG: dump MCP tool schema sizes
  const mcpTools = getMcpTools().filter((t) => VOICE_MCP_TOOLS.has(t.name))
  const totalSize = JSON.stringify(mcpTools).length
  console.log(`[registry] Voice MCP tools total schema size: ${(totalSize / 1024).toFixed(1)}KB`)
  for (const t of mcpTools) {
    const size = JSON.stringify(t.inputSchema).length
    console.log(`[registry]   ${t.name}: ${(size / 1024).toFixed(1)}KB schema`)
  }
}

export function isBuiltInTool(name: string): boolean {
  return BUTLER_TOOLS.some((t) => t.name === name)
}

/** Get the curated tool set for Ollama (voice-relevant MCP tools + butler tools). */
export function getOllamaTools(): OllamaTool[] {
  const mcpTools = getMcpTools()
    .filter((t) => VOICE_MCP_TOOLS.has(t.name))
    .map((t): OllamaTool => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

  const butlerTools = BUTLER_TOOLS.map((t): OllamaTool => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))

  return [...mcpTools, ...butlerTools]
}
