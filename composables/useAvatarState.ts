type DisplayState = 'IDLE' | 'PASSIVE' | 'LISTENING' | 'THINKING' | 'EXECUTING' | 'SPEAKING'

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
  coreScale: number       // base uniform scale (1.0 = normal)
  coreSpin: number        // rotation speed (0 = none, high = fast spin)
  coreDistort: number     // non-uniform scale wobble amount (0 = none)
  coreMorph: number       // 0 = sphere, 1 = target shape
  coreShape: number       // 0 = diamond target, 1 = hexagon target
}

// Aperture palette
const AP_GREY   = { r: 0.45, g: 0.45, b: 0.45 }  // neutral idle
const AP_ORANGE = { r: 1.0,  g: 0.4,  b: 0.0 }   // #ff6600 — passive
const AP_BLUE   = { r: 0.2,  g: 0.667, b: 1.0 }   // #33aaff — listening
const AP_AMBER  = { r: 1.0,  g: 0.65, b: 0.1 }    // #ffa61a — thinking
const AP_GREEN  = { r: 0.2,  g: 0.9,  b: 0.3 }    // #33e64d — executing
const AP_PURPLE = { r: 0.65, g: 0.2,  b: 0.9 }    // #a633e6 — speaking

const STATE_PARAMS: Record<DisplayState, AvatarParams> = {
  IDLE: {
    ringSpeed: 0.06,
    coreIntensity: 0.7,
    primaryR: AP_GREY.r, primaryG: AP_GREY.g, primaryB: AP_GREY.b,
    particleSpeed: 0.03,
    particleOpacity: 0.15,
    panelFlipping: 0.0,
    bloomIntensity: 0.5,
    coreScale: 1.0,
    coreSpin: 0.0,
    coreDistort: 0.0,
    coreMorph: 0.0,
    coreShape: 0.0,
  },
  PASSIVE: {
    ringSpeed: 0.04,
    coreIntensity: 0.5,
    primaryR: AP_ORANGE.r, primaryG: AP_ORANGE.g, primaryB: AP_ORANGE.b,
    particleSpeed: 0.02,
    particleOpacity: 0.12,
    panelFlipping: 0.0,
    bloomIntensity: 0.35,
    coreScale: 1.0,
    coreSpin: 0.0,
    coreDistort: 0.0,
    coreMorph: 0.0,
    coreShape: 0.0,
  },
  LISTENING: {
    ringSpeed: 0.35,
    coreIntensity: 1.8,
    primaryR: AP_BLUE.r, primaryG: AP_BLUE.g, primaryB: AP_BLUE.b,
    particleSpeed: 0.12,
    particleOpacity: 0.4,
    panelFlipping: 0.0,
    bloomIntensity: 1.4,
    coreScale: 0.8,
    coreSpin: 0.0,
    coreDistort: 0.0,
    coreMorph: 0.0,
    coreShape: 0.0,
  },
  THINKING: {
    ringSpeed: 0.5,
    coreIntensity: 2.2,
    primaryR: AP_AMBER.r, primaryG: AP_AMBER.g, primaryB: AP_AMBER.b,
    particleSpeed: 0.25,
    particleOpacity: 0.5,
    panelFlipping: 1.0,
    bloomIntensity: 1.8,
    coreScale: 1.0,
    coreSpin: 6.0,
    coreDistort: 0.08,
    coreMorph: 1.0,
    coreShape: 1.0,
  },
  EXECUTING: {
    ringSpeed: 0.4,
    coreIntensity: 2.2,
    primaryR: AP_GREEN.r, primaryG: AP_GREEN.g, primaryB: AP_GREEN.b,
    particleSpeed: 0.2,
    particleOpacity: 0.5,
    panelFlipping: 0.0,
    bloomIntensity: 1.6,
    coreScale: 1.0,
    coreSpin: 0.0,
    coreDistort: 0.15,
    coreMorph: 0.0,
    coreShape: 0.0,
  },
  SPEAKING: {
    ringSpeed: 0.25,
    coreIntensity: 1.6,
    primaryR: AP_PURPLE.r, primaryG: AP_PURPLE.g, primaryB: AP_PURPLE.b,
    particleSpeed: 0.12,
    particleOpacity: 0.4,
    panelFlipping: 0.0,
    bloomIntensity: 1.2,
    coreScale: 1.0,
    coreSpin: 0.0,
    coreDistort: 0.1,
    coreMorph: 1.0,
    coreShape: 0.0,
  },
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
