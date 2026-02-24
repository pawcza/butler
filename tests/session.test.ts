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

  it('adds messages and returns a copy of history', () => {
    const sm = new SessionManager(vi.fn())
    sm.addMessage({ role: 'user', content: 'hello' })
    sm.addMessage({ role: 'assistant', content: 'hi' })
    const h = sm.getHistory()
    expect(h).toHaveLength(2)
    expect(h[0]?.content).toBe('hello')
  })

  it('caps history at 10 messages, dropping oldest', () => {
    const sm = new SessionManager(vi.fn())
    for (let i = 0; i < 12; i++) {
      sm.addMessage({ role: 'user', content: `msg${i}` })
    }
    const h = sm.getHistory()
    expect(h).toHaveLength(10)
    expect(h[0]?.content).toBe('msg2')
  })

  it('getHistory returns a copy, not a reference', () => {
    const sm = new SessionManager(vi.fn())
    sm.addMessage({ role: 'user', content: 'x' })
    const h = sm.getHistory()
    h.pop()
    expect(sm.getHistory()).toHaveLength(1)
  })

  it('clearHistory empties the history', () => {
    const sm = new SessionManager(vi.fn())
    sm.addMessage({ role: 'user', content: 'x' })
    sm.clearHistory()
    expect(sm.getHistory()).toHaveLength(0)
  })
})
