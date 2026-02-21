import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/utils/registry', () => ({
  isValidTool: (name: string) => ['turn_on_light', 'turn_off_light', 'set_temperature'].includes(name),
  isValidEntity: (id: string) => ['light.living_room', 'light.kitchen', 'climate.bedroom'].includes(id),
}))

// Import AFTER mock is set up
const { validate } = await import('../server/utils/validator')

describe('validate', () => {
  it('returns conversation for plain text', () => {
    const r = validate('I cannot do that.')
    expect(r.type).toBe('conversation')
    if (r.type === 'conversation') expect(r.text).toBe('I cannot do that.')
  })

  it('parses a single tool call object', () => {
    const r = validate('{"tool":"turn_on_light","entity_id":"light.living_room"}')
    expect(r.type).toBe('tool_calls')
    if (r.type === 'tool_calls') {
      expect(r.calls).toHaveLength(1)
      expect(r.calls[0]?.tool).toBe('turn_on_light')
    }
  })

  it('parses a JSON array as multiple tool calls', () => {
    const r = validate('[{"tool":"turn_on_light","entity_id":"light.living_room"},{"tool":"turn_off_light","entity_id":"light.kitchen"}]')
    expect(r.type).toBe('tool_calls')
    if (r.type === 'tool_calls') expect(r.calls).toHaveLength(2)
  })

  it('extracts JSON embedded in surrounding prose', () => {
    const r = validate('Sure thing! {"tool":"turn_on_light","entity_id":"light.living_room"} Done.')
    expect(r.type).toBe('tool_calls')
  })

  it('strips MODE N: prefix before parsing', () => {
    const r = validate('MODE 1: {"tool":"turn_on_light","entity_id":"light.living_room"}')
    expect(r.type).toBe('tool_calls')
  })

  it('returns error for hallucinated tool name', () => {
    const r = validate('{"tool":"explode_house","entity_id":"light.living_room"}')
    expect(r.type).toBe('error')
    if (r.type === 'error') expect(r.message).toContain('Hallucinated tool name')
  })

  it('returns error for hallucinated entity_id', () => {
    const r = validate('{"tool":"turn_on_light","entity_id":"light.nonexistent"}')
    expect(r.type).toBe('error')
    if (r.type === 'error') expect(r.message).toContain('Hallucinated entity_id')
  })

  it('returns error for malformed JSON', () => {
    const r = validate('{broken json}')
    expect(r.type).toBe('error')
  })

  it('preserves extra params like temperature', () => {
    const r = validate('{"tool":"set_temperature","entity_id":"climate.bedroom","temperature":22}')
    expect(r.type).toBe('tool_calls')
    if (r.type === 'tool_calls') {
      expect((r.calls[0] as Record<string, unknown>)['temperature']).toBe(22)
    }
  })
})
