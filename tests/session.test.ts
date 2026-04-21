import { describe, it, expect, vi } from 'vitest'
import { SessionManager } from '../server/utils/session'

describe('SessionManager', () => {
  it('starts in IDLE state', () => {
    const sm = new SessionManager(vi.fn())
    expect(sm.getState()).toBe('IDLE')
  })

  it('calls onStateChange when state changes', () => {
    const cb = vi.fn()
    const sm = new SessionManager(cb)
    sm.setState('LISTENING')
    expect(cb).toHaveBeenCalledWith('LISTENING')
  })

  it('defaults personality to glados', () => {
    const sm = new SessionManager(vi.fn())
    expect(sm.getPersonality()).toBe('glados')
  })

  it('setPersonality updates and getPersonality returns it', () => {
    const sm = new SessionManager(vi.fn())
    sm.setPersonality('butler')
    expect(sm.getPersonality()).toBe('butler')
    sm.setPersonality('flirty')
    expect(sm.getPersonality()).toBe('flirty')
  })
})
