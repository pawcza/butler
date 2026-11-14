import { describe, expect, it, vi } from 'vitest'
import { createWarmup } from '../server/utils/tts-warmup'

function setup() {
  let now = 1_000_000
  const run = vi.fn(() => Promise.resolve())
  const warmup = createWarmup({ run, now: () => now })
  return { run, warmup, advance: (ms: number) => { now += ms } }
}

describe('createWarmup', () => {
  it('fires one throwaway synthesis when nothing has been synthesized yet', () => {
    const { run, warmup } = setup()
    expect(warmup.fire()).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it('does nothing within 30 s of a finished synthesis, and fires again after', () => {
    const { run, warmup, advance } = setup()
    warmup.touch()
    advance(29_999)
    expect(warmup.fire()).toBe(false)
    advance(2)
    expect(warmup.fire()).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it('does not stack a second warm-up on one still running', async () => {
    let finish: () => void = () => {}
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const warmup = createWarmup({ run })
    expect(warmup.fire()).toBe(true)
    expect(warmup.fire()).toBe(false)
    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(warmup.fire()).toBe(true)
  })

  it('swallows a failure, and tries again on the next turn', async () => {
    const run = vi.fn(() => Promise.reject(new Error('speech server is down')))
    const warmup = createWarmup({ run })
    expect(warmup.fire()).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(warmup.fire()).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
