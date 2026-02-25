type CoreShape = 'sphere' | 'diamond' | 'hexagon'
type DisplayState = 'IDLE' | 'PASSIVE' | 'HEARING' | 'LISTENING' | 'THINKING' | 'EXECUTING' | 'SPEAKING'

interface RGB { r: number; g: number; b: number }

/** Params the render loop (ButlerScene.vue) consumes — all numeric for lerping. */
export interface AvatarParams {
  ringSpeed: number
  coreIntensity: number
  primaryR: number
  primaryG: number
  primaryB: number
  particleSpeed: number
  particleOpacity: number
  panelFlipping: number
  bloomIntensity: number
  coreScale: number
  coreSpin: number
  coreDistort: number
  coreMorph: number       // 0 = sphere, 1 = target shape (resolved from CoreShape)
  coreShape: number       // 0 = diamond target, 1 = hexagon target (resolved from CoreShape)
}

// ── Palette ──────────────────────────────────────────────────────────────────
const AP_GREY      : RGB = { r: 0.45, g: 0.45, b: 0.45 }
const AP_ORANGE    : RGB = { r: 1.0,  g: 0.4,  b: 0.0 }
const AP_WARMWHITE : RGB = { r: 1.0,  g: 0.85, b: 0.5 }
const AP_BLUE      : RGB = { r: 0.2,  g: 0.667, b: 1.0 }
const AP_AMBER     : RGB = { r: 1.0,  g: 0.65, b: 0.1 }
const AP_GREEN     : RGB = { r: 0.2,  g: 0.9,  b: 0.3 }
const AP_PURPLE    : RGB = { r: 0.65, g: 0.2,  b: 0.9 }

// ── Shape resolution ─────────────────────────────────────────────────────────
function resolveShape(shape: CoreShape): { coreMorph: number; coreShape: number } {
  switch (shape) {
    case 'sphere':  return { coreMorph: 0, coreShape: 0 }
    case 'diamond': return { coreMorph: 1, coreShape: 0 }
    case 'hexagon': return { coreMorph: 1, coreShape: 1 }
  }
}

// ── Defaults + overrides ─────────────────────────────────────────────────────
interface StateOverride {
  color: RGB
  shape: CoreShape
  ringSpeed: number
  coreIntensity: number
  particleSpeed: number
  particleOpacity: number
  panelFlipping: number
  bloomIntensity: number
  coreScale: number
  coreSpin: number
  coreDistort: number
}

const DEFAULTS: StateOverride = {
  color: AP_GREY,
  shape: 'sphere',
  ringSpeed: 0.06,
  coreIntensity: 0.7,
  particleSpeed: 0.03,
  particleOpacity: 0.15,
  panelFlipping: 0,
  bloomIntensity: 0.5,
  coreScale: 1.0,
  coreSpin: 0,
  coreDistort: 0,
}

const STATE_OVERRIDES: Record<DisplayState, Partial<StateOverride>> = {
  IDLE:      {},
  PASSIVE:   { color: AP_ORANGE, ringSpeed: 0.04, coreIntensity: 0.5, particleSpeed: 0.02, particleOpacity: 0.12, bloomIntensity: 0.35 },
  HEARING:   { color: AP_WARMWHITE, ringSpeed: 0.15, coreIntensity: 1.2, particleSpeed: 0.08, particleOpacity: 0.3, bloomIntensity: 1.0 },
  LISTENING: { color: AP_BLUE, ringSpeed: 0.35, coreIntensity: 1.8, particleSpeed: 0.12, particleOpacity: 0.4, bloomIntensity: 1.4, coreScale: 0.8 },
  THINKING:  { color: AP_AMBER, ringSpeed: 0.5, coreIntensity: 2.2, particleSpeed: 0.25, particleOpacity: 0.5, panelFlipping: 1.0, bloomIntensity: 1.8, coreSpin: 6.0, coreDistort: 0.08, shape: 'hexagon' },
  EXECUTING: { color: AP_GREEN, ringSpeed: 0.4, coreIntensity: 2.2, particleSpeed: 0.2, particleOpacity: 0.5, bloomIntensity: 1.6, coreDistort: 0.15 },
  SPEAKING:  { color: AP_PURPLE, ringSpeed: 0.25, coreIntensity: 1.6, particleSpeed: 0.12, particleOpacity: 0.4, bloomIntensity: 1.2, coreDistort: 0.1, shape: 'diamond' },
}

/** Resolve a state override into the full numeric AvatarParams for the render loop. */
function resolveParams(overrides: Partial<StateOverride>): AvatarParams {
  const merged = { ...DEFAULTS, ...overrides }
  const { coreMorph, coreShape } = resolveShape(merged.shape)
  return {
    ringSpeed: merged.ringSpeed,
    coreIntensity: merged.coreIntensity,
    primaryR: merged.color.r,
    primaryG: merged.color.g,
    primaryB: merged.color.b,
    particleSpeed: merged.particleSpeed,
    particleOpacity: merged.particleOpacity,
    panelFlipping: merged.panelFlipping,
    bloomIntensity: merged.bloomIntensity,
    coreScale: merged.coreScale,
    coreSpin: merged.coreSpin,
    coreDistort: merged.coreDistort,
    coreMorph,
    coreShape,
  }
}

// Pre-resolve all states into numeric params for fast lookup in render loop
const STATE_PARAMS: Record<DisplayState, AvatarParams> = {} as Record<DisplayState, AvatarParams>
for (const [state, overrides] of Object.entries(STATE_OVERRIDES) as [DisplayState, Partial<StateOverride>][]) {
  STATE_PARAMS[state] = resolveParams(overrides)
}

const PARAM_KEYS = Object.keys(STATE_PARAMS.IDLE) as (keyof AvatarParams)[]

function cloneParams(src: AvatarParams): AvatarParams {
  const out = {} as AvatarParams
  for (const k of PARAM_KEYS) out[k] = src[k]
  return out
}

export function useAvatarState(activeState: Ref<string>) {
  const current = cloneParams(STATE_PARAMS[(activeState.value as DisplayState) ?? 'IDLE'] ?? STATE_PARAMS.IDLE)

  function update(dt: number): void {
    const target = STATE_PARAMS[activeState.value as DisplayState] ?? STATE_PARAMS.IDLE
    const t = 1 - Math.exp(-8 * dt)
    for (const k of PARAM_KEYS) {
      current[k] += (target[k] - current[k]) * t
    }
  }

  return { current, update }
}
