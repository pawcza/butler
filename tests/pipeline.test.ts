import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OllamaMessage, ServerEvent } from '../shared/types'
import { SessionManager } from '../server/utils/session'

// ── Stub Nitro auto-imports as globals ───────────────────────────────────────

const chatWithToolsMock = vi.fn()
const executeHaToolMock = vi.fn()
const executeBuiltInMock = vi.fn()
const synthesizeMock = vi.fn()

const noopLog = { info: vi.fn(), ok: vi.fn(), fail: vi.fn(), warn: vi.fn(), table: vi.fn(), divider: vi.fn() }
vi.stubGlobal('createLog', () => noopLog)
vi.stubGlobal('buildSystemPrompt', () => 'You are GLaDOS.')
vi.stubGlobal('chatWithTools', (...args: unknown[]) => chatWithToolsMock(...args))
vi.stubGlobal('executeHaTool', (...args: unknown[]) => executeHaToolMock(...args))
vi.stubGlobal('executeBuiltIn', (...args: unknown[]) => executeBuiltInMock(...args))
vi.stubGlobal('synthesize', (...args: unknown[]) => synthesizeMock(...args))
vi.stubGlobal('config', { PIPER_RESPONSE_FORMAT: 'mp3' })
vi.stubGlobal('isBuiltInTool', (name: string) =>
  ['timer_start', 'timer_stop', 'timer_check', 'news_briefing'].includes(name),
)
vi.stubGlobal('isHaTool', (name: string) => name.startsWith('ha_'))
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
    expect(executeHaToolMock).not.toHaveBeenCalled()

    const response = events.find((e) => e.type === 'response')
    expect(response).toBeDefined()
    if (response?.type === 'response') {
      expect(response.text).toBe('I am GLaDOS. Your request is noted.')
    }
  })

  it('handles a single HA tool call', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce(assistantMsg('', [
        { function: { name: 'ha_call_service', arguments: { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen' } } },
      ]))
      .mockResolvedValueOnce(assistantMsg('The kitchen light is now on. You are welcome.'))

    executeHaToolMock.mockResolvedValueOnce('Service called successfully')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Turn on the kitchen light', session, emit, 'peer-1')

    expect(executeHaToolMock).toHaveBeenCalledWith('ha_call_service', {
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
    expect(executeHaToolMock).not.toHaveBeenCalled()

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

    executeHaToolMock.mockResolvedValueOnce('Error: Entity not found')

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

    executeHaToolMock.mockResolvedValueOnce('Service called successfully')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Turn off the living room light', session, emit, 'peer-1')

    expect(executeHaToolMock).toHaveBeenCalledWith('ha_call_service', {
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

    executeHaToolMock.mockResolvedValueOnce('OK')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Turn on kitchen light', session, emit, 'peer-1')

    expect(executeHaToolMock).toHaveBeenCalledWith('ha_call_service', {
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

    expect(executeHaToolMock).not.toHaveBeenCalled()
    expect(chatWithToolsMock).toHaveBeenCalledTimes(1)
  })

  it('executes multiple tools in parallel within a single round', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce(assistantMsg('', [
        { function: { name: 'ha_call_service', arguments: { domain: 'light', service: 'turn_on', entity_id: 'light.a' } } },
        { function: { name: 'ha_call_service', arguments: { domain: 'light', service: 'turn_on', entity_id: 'light.b' } } },
      ]))
      .mockResolvedValueOnce(assistantMsg('Both lights are on.'))

    // Track call ordering to prove parallelism: both calls start before either resolves
    const callTimestamps: string[] = []
    executeHaToolMock.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      callTimestamps.push(`start:${args['entity_id'] as string}`)
      await new Promise((r) => setTimeout(r, 10))
      callTimestamps.push(`end:${args['entity_id'] as string}`)
      return 'OK'
    })

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Turn on all lights', session, emit, 'peer-1')

    // Initial call + 1 follow-up = 2
    expect(chatWithToolsMock).toHaveBeenCalledTimes(2)
    expect(executeHaToolMock).toHaveBeenCalledTimes(2)

    // Both calls started before either finished (parallel execution)
    expect(callTimestamps[0]).toBe('start:light.a')
    expect(callTimestamps[1]).toBe('start:light.b')

    const response = events.find((e) => e.type === 'response')
    if (response?.type === 'response') {
      expect(response.text).toBe('Both lights are on.')
    }
  })

  it('handles multi-round tool calls (follow-up returns more tools)', async () => {
    // Round 0: initial LLM call returns tool call
    chatWithToolsMock
      .mockResolvedValueOnce(assistantMsg('', [
        { function: { name: 'ha_get_state', arguments: { entity_id: 'light.kitchen' } } },
      ]))
      // Round 1 follow-up: LLM sees state and decides to call another tool
      .mockResolvedValueOnce(assistantMsg('', [
        { function: { name: 'ha_call_service', arguments: { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen' } } },
      ]))
      // Round 2 follow-up: LLM gives final text
      .mockResolvedValueOnce(assistantMsg('The kitchen light was off, so I turned it on for you.'))

    executeHaToolMock
      .mockResolvedValueOnce('{"state": "off", "entity_id": "light.kitchen"}')
      .mockResolvedValueOnce('Service called successfully')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Make sure the kitchen light is on', session, emit, 'peer-1')

    // Initial call + 2 follow-ups = 3
    expect(chatWithToolsMock).toHaveBeenCalledTimes(3)
    expect(executeHaToolMock).toHaveBeenCalledTimes(2)

    const response = events.find((e) => e.type === 'response')
    if (response?.type === 'response') {
      expect(response.text).toBe('The kitchen light was off, so I turned it on for you.')
    }
  })

  it('stops at max rounds when LLM keeps returning tool calls', async () => {
    // Every LLM response returns a tool call — should stop after 3 rounds
    chatWithToolsMock
      .mockResolvedValueOnce(assistantMsg('', [
        { function: { name: 'ha_get_state', arguments: { entity_id: 'light.a' } } },
      ]))
      .mockResolvedValueOnce(assistantMsg('checking more', [
        { function: { name: 'ha_get_state', arguments: { entity_id: 'light.b' } } },
      ]))
      .mockResolvedValueOnce(assistantMsg('still checking', [
        { function: { name: 'ha_get_state', arguments: { entity_id: 'light.c' } } },
      ]))
      // Round 3 follow-up — still has tool calls but loop should stop here
      .mockResolvedValueOnce(assistantMsg('I could keep going forever', [
        { function: { name: 'ha_get_state', arguments: { entity_id: 'light.d' } } },
      ]))

    executeHaToolMock.mockResolvedValue('{"state": "on"}')

    const { session } = createSession()
    const { events, emit } = collectEvents()

    await processCommand('Check all the lights', session, emit, 'peer-1')

    // Initial call + 3 follow-ups = 4 (max 3 rounds of tool execution)
    expect(chatWithToolsMock).toHaveBeenCalledTimes(4)
    // 3 rounds of tool execution (1 tool each)
    expect(executeHaToolMock).toHaveBeenCalledTimes(3)

    const response = events.find((e) => e.type === 'response')
    if (response?.type === 'response') {
      // Uses the content from the last LLM response
      expect(response.text).toBe('I could keep going forever')
    }
  })

  it('includes conversation history in LLM messages', async () => {
    chatWithToolsMock.mockResolvedValueOnce(assistantMsg('The kitchen light is on.'))

    const { session } = createSession()
    // Add previous conversation to history
    session.addMessage({ role: 'user', content: 'Turn on the kitchen light' })
    session.addMessage({ role: 'assistant', content: 'Done. The kitchen light is now on.' })

    const { emit } = collectEvents()

    await processCommand('What did I just ask you?', session, emit, 'peer-1')

    // Verify the messages array passed to chatWithTools includes history
    const callArgs = chatWithToolsMock.mock.calls[0] as [OllamaMessage[], unknown]
    const messages = callArgs[0]
    // system + 2 history messages + current user message = 4
    expect(messages).toHaveLength(4)
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]?.role).toBe('user')
    expect(messages[1]?.content).toBe('Turn on the kitchen light')
    expect(messages[2]?.role).toBe('assistant')
    expect(messages[2]?.content).toBe('Done. The kitchen light is now on.')
    expect(messages[3]?.role).toBe('user')
    expect(messages[3]?.content).toBe('What did I just ask you?')
  })
})
