import type { ShapeName } from '~/utils/shapes'

type DisplayState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING'

interface RGB { r: number; g: number; b: number }

/** Numeric params consumed by the render loop — all smoothly lerped. */
export interface AvatarParams {
  primaryR: number
  primaryG: number
  primaryB: number
  condense: number          // 0 = galaxy, 1 = fully condensed into shape
  shapeMorph: number        // 0 = previous shape, 1 = current shape (reset on shape change)
  flowSpeed: number         // galaxy orbit/drift speed
  wobbleAmount: number      // organic sine wobble amplitude
  particleBrightness: number // base opacity/brightness
  bloomIntensity: number    // post-processing bloom
  spinSpeed: number         // rotation speed of condensed shape
  chromaticIntensity: number // chromatic aberration offset magnitude
  distortionIntensity: number // heat-haze distortion strength (center-focused)
}

// ── Palette ──────────────────────────────────────────────────────────────────
const AP_GREY: RGB = { r: 0.45, g: 0.45, b: 0.45 }
const AP_ORANGE: RGB = { r: 1.0, g: 0.4, b: 0.0 }
const AP_WARMWHITE: RGB = { r: 1.0, g: 0.85, b: 0.5 }
const AP_BLUE: RGB = { r: 0.2, g: 0.667, b: 1.0 }
const AP_AMBER: RGB = { r: 1.0, g: 0.65, b: 0.1 }
const AP_GREEN: RGB = { r: 0.2, g: 0.9, b: 0.3 }
const AP_PURPLE: RGB = { r: 0.65, g: 0.2, b: 0.9 }

// ── State definitions ────────────────────────────────────────────────────────
interface StateOverride {
  color: RGB
  shape: ShapeName | null   // null = galaxy (no condensed shape)
  condense: number
  flowSpeed: number
  wobbleAmount: number
  particleBrightness: number
  bloomIntensity: number
  spinSpeed: number
  chromaticIntensity: number
  distortionIntensity: number
}

const DEFAULTS: StateOverride = {
  color: AP_GREY,
  shape: null,
  condense: 0,
  flowSpeed: 0.03,
  wobbleAmount: 0.02,
  particleBrightness: 0.15,
  bloomIntensity: 0.03,
  spinSpeed: 0,
  chromaticIntensity: 0.003,
  distortionIntensity: 0,
}

const STATE_OVERRIDES: Record<DisplayState, Partial<StateOverride>> = {
  IDLE: { shape: 'ring', condense: 0.7, flowSpeed: 0.04, particleBrightness: 0.25, wobbleAmount: 0.025, chromaticIntensity: 0.003 },
  LISTENING: { color: AP_BLUE, shape: 'triangle', condense: 1, flowSpeed: 0.08, wobbleAmount: 0.01, particleBrightness: 0.3, bloomIntensity: 0.08, spinSpeed: 0.3, chromaticIntensity: 0.006, distortionIntensity: 0.003 },
  THINKING: { color: AP_AMBER, shape: 'cube', condense: 1, flowSpeed: 0.15, wobbleAmount: 0.015, particleBrightness: 0.35, bloomIntensity: 0.15, spinSpeed: 1.2, chromaticIntensity: 0.012, distortionIntensity: 0.008 },
  SPEAKING: { color: AP_ORANGE, condense: 1, flowSpeed: 0.08, wobbleAmount: 0.01, particleBrightness: 0.3, bloomIntensity: 0.08, spinSpeed: 0.3, chromaticIntensity: 0.008, distortionIntensity: 0.005 },
}

/** Pool of shapes used for SPEAKING — a random one is picked each time, never the same twice. */
export const SPEAKING_SHAPES: ShapeName[] = ['infinity', 'pi', 'alpha', 'omega']

/** Resolve overrides into full numeric AvatarParams. */
function resolveParams(overrides: Partial<StateOverride>): AvatarParams {
  const merged = { ...DEFAULTS, ...overrides }
  return {
    primaryR: merged.color.r,
    primaryG: merged.color.g,
    primaryB: merged.color.b,
    condense: merged.condense,
    shapeMorph: 1, // target is always 1 — reset to 0 on shape change
    flowSpeed: merged.flowSpeed,
    wobbleAmount: merged.wobbleAmount,
    particleBrightness: merged.particleBrightness,
    bloomIntensity: merged.bloomIntensity,
    spinSpeed: merged.spinSpeed,
    chromaticIntensity: merged.chromaticIntensity,
    distortionIntensity: merged.distortionIntensity,
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

/** Resolve the shape name for a given display state (null = galaxy, no shape). */
function resolveShape(state: DisplayState): ShapeName | null {
  const override = STATE_OVERRIDES[state]
  return override?.shape ?? DEFAULTS.shape
}

export function useAvatarState(activeState: Ref<string>) {
  const initial = (activeState.value as DisplayState) ?? 'IDLE'
  const current = cloneParams(STATE_PARAMS[initial] ?? STATE_PARAMS.IDLE)
  let currentShape: ShapeName | null = resolveShape(initial)
  let prevDisplayState: DisplayState | null = null
  let lastSpeakingShape: ShapeName | null = null

  function update(dt: number): { shapeChanged: ShapeName | null } {
    const state = (activeState.value as DisplayState) ?? 'IDLE'
    const target = STATE_PARAMS[state] ?? STATE_PARAMS.IDLE

    // Determine target shape — SPEAKING picks randomly from pool
    let newShape: ShapeName | null
    if (state === 'SPEAKING') {
      if (prevDisplayState !== 'SPEAKING') {
        // Entering SPEAKING — pick random shape, never same as last
        const choices = SPEAKING_SHAPES.filter(s => s !== lastSpeakingShape)
        newShape = choices[Math.floor(Math.random() * choices.length)]!
        lastSpeakingShape = newShape
      } else {
        // Already speaking — keep current shape
        newShape = currentShape
      }
    } else {
      newShape = resolveShape(state)
    }

    prevDisplayState = state

    // Detect shape change — only when moving to a NEW named shape
    let shapeChanged: ShapeName | null = null
    if (newShape !== null && newShape !== currentShape) {
      currentShape = newShape
      current.shapeMorph = 0 // reset so it lerps from old shape to new
      shapeChanged = newShape
    } else if (newShape === null && currentShape !== null) {
      // Going to galaxy — shape stays for condense→0 dissolve, no swap needed
      currentShape = null
    }

    // Lerp all numeric params toward target
    const t = 1 - Math.exp(-8 * dt)
    for (const k of PARAM_KEYS) {
      current[k] += (target[k] - current[k]) * t
    }

    return { shapeChanged }
  }

  return { current, update }
}
