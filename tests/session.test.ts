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

  it('carries the signed-in user id, or null when login is off', () => {
    expect(new SessionManager(vi.fn(), 'sub-1').getUserId()).toBe('sub-1')
    expect(new SessionManager(vi.fn()).getUserId()).toBeNull()
  })

  it('starts without a conversation, so every session is a clean one', () => {
    const sm = new SessionManager(vi.fn())
    expect(sm.getConversationId()).toBeNull()
  })

  it('continues a chosen conversation, and can drop back to a clean one', () => {
    const sm = new SessionManager(vi.fn())
    sm.setConversationId('6f1c2a7e-3b0d-4c8e-9a51-2d4f7b8e0c13')
    expect(sm.getConversationId()).toBe('6f1c2a7e-3b0d-4c8e-9a51-2d4f7b8e0c13')
    sm.setConversationId(null)
    expect(sm.getConversationId()).toBeNull()
  })

  describe('speech and turns', () => {
    it('stopSpeech silences the turn and, while the model is still working, is no longer speaking', () => {
      const states: string[] = []
      const sm = new SessionManager((state) => states.push(state))
      const stop = vi.fn()
      sm.beginTurn()
      sm.onStopSpeech(stop)
      sm.setState('SPEAKING')
      sm.stopSpeech()
      expect(stop).toHaveBeenCalledOnce()
      expect(sm.getState()).toBe('THINKING')
    })

    it('stopSpeech leaves the state alone once only speech is left: the turn ends it', () => {
      const sm = new SessionManager(vi.fn())
      sm.beginTurn()
      sm.onStopSpeech(vi.fn())
      sm.setState('SPEAKING')
      sm.markSpeechOnly()
      sm.stopSpeech()
      expect(sm.getState()).toBe('SPEAKING')
    })

    it('takes a new capture when idle, or when only speech is left, but not while the model works', () => {
      const sm = new SessionManager(vi.fn())
      expect(sm.canCapture()).toBe(true)
      sm.beginTurn()
      sm.setState('SPEAKING')
      expect(sm.canCapture()).toBe(false)
      sm.markSpeechOnly()
      expect(sm.canCapture()).toBe(true)
      sm.setState('THINKING')
      expect(sm.canCapture()).toBe(false)
    })

    it('a new turn starts with no leftover speech state', () => {
      const sm = new SessionManager(vi.fn())
      sm.beginTurn()
      sm.markSpeechOnly()
      sm.beginTurn()
      sm.setState('SPEAKING')
      expect(sm.canCapture()).toBe(false)
    })

    it('finishing the turn goes idle', () => {
      const sm = new SessionManager(vi.fn())
      const turn = sm.beginTurn()
      sm.setState('SPEAKING')
      sm.finishTurn(turn.id)
      expect(sm.getState()).toBe('IDLE')
    })

    it('a superseded turn goes idle at once, stops its speech, and its late finish changes nothing', () => {
      const sm = new SessionManager(vi.fn())
      const turn = sm.beginTurn()
      const stop = vi.fn()
      sm.onStopSpeech(stop)
      sm.setState('SPEAKING')
      sm.markSpeechOnly()
      sm.supersedeTurn()
      expect(stop).toHaveBeenCalledOnce()
      expect(sm.getState()).toBe('IDLE')
      // the barge-in capture is under way when the old turn notices its speech is gone
      sm.setState('LISTENING')
      sm.finishTurn(turn.id)
      expect(sm.getState()).toBe('LISTENING')
    })
  })

  describe('close', () => {
    it('aborts the running turn and runs the close hooks once', () => {
      const sm = new SessionManager(vi.fn())
      const turn = sm.beginTurn()
      const hook = vi.fn()
      sm.onClose(hook)
      sm.close()
      sm.close()
      expect(sm.isClosed).toBe(true)
      expect(turn.signal.aborted).toBe(true)
      expect(hook).toHaveBeenCalledOnce()
    })

    it('a closed session begins every turn already aborted', () => {
      const sm = new SessionManager(vi.fn())
      sm.close()
      expect(sm.beginTurn().signal.aborted).toBe(true)
    })

    it('a hook registered after the close runs at once; an unregistered one never runs', () => {
      const sm = new SessionManager(vi.fn())
      const skipped = vi.fn()
      sm.onClose(skipped)()
      sm.close()
      expect(skipped).not.toHaveBeenCalled()
      const late = vi.fn()
      sm.onClose(late)
      expect(late).toHaveBeenCalledOnce()
    })
  })
})
