import { describe, it, expect } from 'vitest'

// useAvatarState expects a Ref<string> — we mock it as a plain object with .value
// (the composable only reads .value, so this is sufficient for testing)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRef(initial: string): any {
  return { value: initial }
}

const { useAvatarState, SPEAKING_SHAPES } = await import('../composables/useAvatarState')

describe('useAvatarState', () => {
  it('starts with IDLE params', () => {
    const state = makeRef('IDLE')
    const { current } = useAvatarState(state)
    expect(current.condense).toBe(0.7)
    expect(current.flowSpeed).toBeGreaterThan(0)
    expect(current.bloomIntensity).toBeGreaterThan(0)
  })

  it('lerps numeric params toward target state', () => {
    const state = makeRef('IDLE')
    const { current, update } = useAvatarState(state)
    const initialBloom = current.bloomIntensity

    state.value = 'THINKING'
    // Simulate several frames of lerping
    for (let i = 0; i < 60; i++) update(1 / 60)

    expect(current.condense).toBeGreaterThan(0.9)
    expect(current.bloomIntensity).toBeGreaterThan(initialBloom)
  })

  it('returns shapeChanged when entering a shape state', () => {
    const state = makeRef('IDLE')
    const { update } = useAvatarState(state)

    state.value = 'LISTENING'
    const result = update(1 / 60)
    expect(result.shapeChanged).toBe('triangle')
  })

  it('returns shapeChanged: null when shape does not change', () => {
    const state = makeRef('IDLE')
    const { update } = useAvatarState(state)

    // First frame — no shape state
    const result = update(1 / 60)
    expect(result.shapeChanged).toBeNull()
  })

  it('resets shapeMorph to 0 on shape change', () => {
    const state = makeRef('LISTENING')
    const { current, update } = useAvatarState(state)

    // Lerp until shapeMorph is near 1
    for (let i = 0; i < 60; i++) update(1 / 60)
    expect(current.shapeMorph).toBeGreaterThan(0.9)

    // Change to different shape state
    state.value = 'THINKING'
    update(1 / 60)
    // shapeMorph should have been reset to 0 then lerped one frame
    expect(current.shapeMorph).toBeLessThan(0.3)
  })

  it('detects shape-to-shape transition', () => {
    const state = makeRef('LISTENING')
    const { update } = useAvatarState(state)
    update(1 / 60) // first frame — triangle

    state.value = 'SPEAKING'
    const result = update(1 / 60)
    expect(SPEAKING_SHAPES).toContain(result.shapeChanged)
  })

  it('SPEAKING never picks the same shape twice in a row', () => {
    const state = makeRef('IDLE')
    const { update } = useAvatarState(state)
    update(1 / 60) // init

    const shapes: (string | null)[] = []
    for (let i = 0; i < 20; i++) {
      state.value = 'SPEAKING'
      const r = update(1 / 60)
      if (r.shapeChanged) shapes.push(r.shapeChanged)
      // Go back to IDLE so next SPEAKING triggers a new pick
      state.value = 'IDLE'
      update(1 / 60)
    }

    // No two consecutive shapes should be the same
    for (let i = 1; i < shapes.length; i++) {
      expect(shapes[i]).not.toBe(shapes[i - 1])
    }
    // Should have used more than one shape across 20 picks
    expect(new Set(shapes).size).toBeGreaterThan(1)
  })

  it('returns shapeChanged when going from one shape to another via IDLE', () => {
    const state = makeRef('LISTENING')
    const { update } = useAvatarState(state)
    update(1 / 60) // triangle

    state.value = 'IDLE'
    const result = update(1 / 60)
    // IDLE has shape 'ring', LISTENING had 'triangle' — shape change fires
    expect(result.shapeChanged).toBe('ring')
  })

  it('GRACE state has orange color and ring shape', () => {
    const state = makeRef('GRACE')
    const { current } = useAvatarState(state)
    // AP_ORANGE = { r: 1.0, g: 0.4, b: 0.0 }
    expect(current.primaryR).toBe(1.0)
    expect(current.primaryG).toBe(0.4)
    expect(current.primaryB).toBe(0.0)
    // Same condense as IDLE (ring shape)
    expect(current.condense).toBe(0.7)
  })

  it('SPEAKING → GRACE transitions shape to ring', () => {
    const state = makeRef('SPEAKING')
    const { update } = useAvatarState(state)
    update(1 / 60) // pick a speaking shape

    state.value = 'GRACE'
    const result = update(1 / 60)
    expect(result.shapeChanged).toBe('ring')
  })
})
