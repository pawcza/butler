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

  it('tts preferences default to null', () => {
    const sm = new SessionManager(vi.fn())
    expect(sm.getTtsModel()).toBeNull()
    expect(sm.getTtsVoice()).toBeNull()
  })

  it('setTtsPreferences updates model and voice', () => {
    const sm = new SessionManager(vi.fn())
    sm.setTtsPreferences('speaches-ai/Kokoro-82M-v1.0-ONNX', 'af_heart')
    expect(sm.getTtsModel()).toBe('speaches-ai/Kokoro-82M-v1.0-ONNX')
    expect(sm.getTtsVoice()).toBe('af_heart')
  })
})
