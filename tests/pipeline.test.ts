import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OllamaMessage, ServerEvent } from '../shared/types'
import { SessionManager } from '../server/utils/session'

// ── Stub Nitro auto-imports as globals ───────────────────────────────────────

const chatWithToolsMock = vi.fn()
const executeMcpToolMock = vi.fn()
const executeBuiltInMock = vi.fn()
const synthesizeMock = vi.fn()

vi.stubGlobal('buildSystemPrompt', () => 'You are GLaDOS.')
vi.stubGlobal('chatWithTools', (...args: unknown[]) => chatWithToolsMock(...args))
vi.stubGlobal('executeMcpTool', (...args: unknown[]) => executeMcpToolMock(...args))
vi.stubGlobal('executeBuiltIn', (...args: unknown[]) => executeBuiltInMock(...args))
vi.stubGlobal('synthesize', (...args: unknown[]) => synthesizeMock(...args))
vi.stubGlobal('config', { PIPER_RESPONSE_FORMAT: 'mp3' })
vi.stubGlobal('isBuiltInTool', (name: string) =>
  ['timer_start', 'timer_stop', 'timer_check', 'news_briefing'].includes(name),
)
vi.stubGlobal('isMcpTool', (name: string) =>
  ['ha_call_service', 'ha_get_state'].includes(name),
)
vi.stubGlobal('getOllamaTools', () => [
  { type: 'function', function: { name: 'ha_call_service', description: 'Call HA service', parameters: {} } },
  { type: 'function', function: { name: 'timer_start', description: 'Start timer', parameters: {} } },
])

const { processCommand } = await import('../server/utils/pipeline')

// ── Helpers ──────────────────────────────────────────────────────────────────

function createSession() {
  const states: string[] = []
  const session = new SessionManager((s) => states.push(s))
  return { session, states }
}

function collectEvents() {
  const events: ServerEvent[] = []
  const emit = (e: ServerEvent) => events.push(e)
  return { events, emit }
}

function assistantMsg(content: string, toolCalls?: OllamaMessage['tool_calls']): OllamaMessage {
  return {
    role: 'assistant',
    content,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('processCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    synthesizeMock.mockResolvedValue(Buffer.from('audio'))
  })

  it('handles plain conversation (no tool calls)', async () => {
    chatWithToolsMock.mockResolvedValueOnce(assistantMsg('I am GLaDOS. Your request is noted.'))

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Hello', session, emit, 'peer-1')

    expect(chatWithToolsMock).toHaveBeenCalledTimes(1)
    expect(executeMcpToolMock).not.toHaveBeenCalled()

    const response = events.find((e) => e.type === 'response')
    expect(response).toBeDefined()
    if (response?.type === 'response') {
      expect(response.text).toBe('I am GLaDOS. Your request is noted.')
    }
  })

  it('handles a single MCP tool call', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce(assistantMsg('', [
        { function: { name: 'ha_call_service', arguments: { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen' } } },
      ]))
      .mockResolvedValueOnce(assistantMsg('The kitchen light is now on. You are welcome.'))

    executeMcpToolMock.mockResolvedValueOnce('Service called successfully')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Turn on the kitchen light', session, emit, 'peer-1')

    expect(executeMcpToolMock).toHaveBeenCalledWith('ha_call_service', {
      domain: 'light',
      service: 'turn_on',
      entity_id: 'light.kitchen',
    })

    expect(chatWithToolsMock).toHaveBeenCalledTimes(2)
    const response = events.find((e) => e.type === 'response')
    if (response?.type === 'response') {
      expect(response.text).toBe('The kitchen light is now on. You are welcome.')
    }
  })

  it('routes butler tool calls to executeBuiltIn', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce(assistantMsg('', [
        { function: { name: 'timer_start', arguments: { duration_seconds: 300, label: 'pasta' } } },
      ]))
      .mockResolvedValueOnce(assistantMsg('Timer set. Try not to burn anything.'))

    executeBuiltInMock.mockResolvedValueOnce('Timer "pasta" started for 300 seconds.')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Set a 5 minute timer for pasta', session, emit, 'peer-1')

    expect(executeBuiltInMock).toHaveBeenCalledWith(
      'timer_start',
      { duration_seconds: 300, label: 'pasta' },
      expect.objectContaining({ peerId: 'peer-1' }),
    )
    expect(executeMcpToolMock).not.toHaveBeenCalled()

    const response = events.find((e) => e.type === 'response')
    if (response?.type === 'response') {
      expect(response.text).toBe('Timer set. Try not to burn anything.')
    }
  })

  it('handles tool errors gracefully', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce(assistantMsg('', [
        { function: { name: 'ha_call_service', arguments: { domain: 'light', service: 'turn_on', entity_id: 'light.nonexistent' } } },
      ]))
      .mockResolvedValueOnce(assistantMsg('That entity does not exist. How typical.'))

    executeMcpToolMock.mockResolvedValueOnce('Error: Entity not found')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Turn on nonexistent light', session, emit, 'peer-1')

    const response = events.find((e) => e.type === 'response')
    if (response?.type === 'response') {
      expect(response.text).toBe('That entity does not exist. How typical.')
    }
  })

  it('extracts tool calls from text content (fallback for qwen2.5)', async () => {
    // Model outputs JSON as text instead of structured tool_calls
    chatWithToolsMock
      .mockResolvedValueOnce(assistantMsg(
        'Sure! {"name": "ha_call_service", "arguments": {"domain": "light", "service": "turn_off", "entity_id": "light.living_room"}}',
      ))
      .mockResolvedValueOnce(assistantMsg('The living room light has been turned off.'))

    executeMcpToolMock.mockResolvedValueOnce('Service called successfully')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Turn off the living room light', session, emit, 'peer-1')

    expect(executeMcpToolMock).toHaveBeenCalledWith('ha_call_service', {
      domain: 'light',
      service: 'turn_off',
      entity_id: 'light.living_room',
    })

    const response = events.find((e) => e.type === 'response')
    if (response?.type === 'response') {
      expect(response.text).toBe('The living room light has been turned off.')
    }
  })

  it('extracts old-format tool calls from text (fallback)', async () => {
    // Model outputs old [{"tool": "x", ...}] format
    chatWithToolsMock
      .mockResolvedValueOnce(assistantMsg(
        '[{"tool": "ha_call_service", "domain": "light", "service": "turn_on", "entity_id": "light.kitchen"}]',
      ))
      .mockResolvedValueOnce(assistantMsg('Kitchen light activated.'))

    executeMcpToolMock.mockResolvedValueOnce('OK')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Turn on kitchen light', session, emit, 'peer-1')

    expect(executeMcpToolMock).toHaveBeenCalledWith('ha_call_service', {
      domain: 'light',
      service: 'turn_on',
      entity_id: 'light.kitchen',
    })
  })

  it('ignores JSON with unknown tool names (not a tool call)', async () => {
    // Model outputs JSON but with hallucinated tool name — treat as conversation
    chatWithToolsMock.mockResolvedValueOnce(assistantMsg(
      '{"name": "explode_house", "arguments": {"target": "everything"}}',
    ))

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Blow up the house', session, emit, 'peer-1')

    expect(executeMcpToolMock).not.toHaveBeenCalled()
    expect(chatWithToolsMock).toHaveBeenCalledTimes(1)
  })

  it('respects max tool rounds guard', async () => {
    const toolCallMsg = assistantMsg('', [
      { function: { name: 'ha_call_service', arguments: { domain: 'light', service: 'turn_on', entity_id: 'light.a' } } },
    ])

    chatWithToolsMock.mockResolvedValue(toolCallMsg)
    executeMcpToolMock.mockResolvedValue('OK')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Do something loopy', session, emit, 'peer-1')

    // Initial call + 5 follow-ups (MAX_TOOL_ROUNDS) = 6
    expect(chatWithToolsMock).toHaveBeenCalledTimes(6)

    const response = events.find((e) => e.type === 'response')
    expect(response).toBeDefined()
  })
})
