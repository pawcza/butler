<script setup lang="ts">
import {
  SphereGeometry,
  TorusGeometry,
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  PointsMaterial,
  Color,
  AdditiveBlending,
  Vector3,
  type Mesh,
  type Points,
  type PointLight,
  type PerspectiveCamera,
} from 'three'
import { BloomPmndrs, EffectComposerPmndrs } from '@tresjs/post-processing'

const props = withDefaults(defineProps<{
  activeState: string
  audioEnergy?: number
  micEnergy?: number
}>(), {
  audioEnergy: 0,
  micEnergy: 0,
})

const activeStateRef = toRef(props, 'activeState')
const { current: ap, update: updateAp } = useAvatarState(activeStateRef)

// ---------- Geometries (created once) ----------
const coreGeo = new SphereGeometry(0.6, 64, 64)

// Precompute diamond (octahedron) target positions from sphere vertices.
// For each vertex direction, project onto octahedron surface: r / (|nx|+|ny|+|nz|)
// Then stretch Y for a tall diamond look.
const spherePositions = new Float32Array(coreGeo.attributes['position']!.array as Float32Array)
const diamondPositions = new Float32Array(spherePositions.length)
for (let i = 0; i < spherePositions.length; i += 3) {
  const x = spherePositions[i]!
  const y = spherePositions[i + 1]!
  const z = spherePositions[i + 2]!
  const len = Math.sqrt(x * x + y * y + z * z)
  if (len < 0.001) {
    diamondPositions[i] = x
    diamondPositions[i + 1] = y
    diamondPositions[i + 2] = z
    continue
  }
  const nx = x / len
  const ny = y / len
  const nz = z / len
  const octR = 0.6 / (Math.abs(nx) + Math.abs(ny) + Math.abs(nz))
  diamondPositions[i] = nx * octR * 0.75
  diamondPositions[i + 1] = ny * octR * 1.35   // taller — diamond shape
  diamondPositions[i + 2] = nz * octR * 0.75
}
// Precompute hexagonal prism target positions from sphere vertices.
// Project XZ onto a regular hexagon cross-section, flatten Y for a chunky prism.
const hexPositions = new Float32Array(spherePositions.length)
const HEX_SIDES = 6
for (let i = 0; i < spherePositions.length; i += 3) {
  const x = spherePositions[i]!
  const y = spherePositions[i + 1]!
  const z = spherePositions[i + 2]!
  const len = Math.sqrt(x * x + y * y + z * z)
  if (len < 0.001) {
    hexPositions[i] = x
    hexPositions[i + 1] = y
    hexPositions[i + 2] = z
    continue
  }
  // Hex cross-section: distance from center to edge of regular hexagon
  const angle = Math.atan2(z, x)
  const sectorAngle = (Math.PI * 2) / HEX_SIDES
  const sectorPhase = ((angle % sectorAngle) + sectorAngle) % sectorAngle - sectorAngle / 2
  const hexScale = Math.cos(sectorAngle / 2) / Math.cos(sectorPhase)
  const rXZ = Math.sqrt(x * x + z * z)
  const rTarget = rXZ > 0.001 ? Math.min(rXZ, 0.6 * hexScale) : 0
  const nx = rXZ > 0.001 ? x / rXZ : 0
  const nz = rXZ > 0.001 ? z / rXZ : 0
  hexPositions[i] = nx * rTarget
  hexPositions[i + 1] = y * 0.85   // slightly squashed vertically
  hexPositions[i + 2] = nz * rTarget
}

let lastMorph = -1  // track to avoid unnecessary vertex updates
let lastShape = -1

// 4 ring segments at varied radii, tube thickness, and arc lengths
const RING_COUNT = 4
const ringGeos = [
  new TorusGeometry(1.8, 0.035, 16, 64, Math.PI * 1.2),
  new TorusGeometry(1.4, 0.03, 16, 48, Math.PI * 0.9),
  new TorusGeometry(1.1, 0.025, 16, 40, Math.PI * 0.7),
  new TorusGeometry(1.6, 0.028, 16, 56, Math.PI * 1.0),
]

// Each ring: [tiltX, tiltY, direction, speed multiplier, startZ]
const ringConfigs: [number, number, number, number, number][] = [
  [0.4, 0.0, 1, 1.0, 1.2],
  [-0.6, 0.3, -1, 0.8, 3.8],
  [0.25, -0.2, 1, 1.2, 5.5],
  [1.2, 0.5, -1, 0.7, 0.7],
]

const panelGeo = new BoxGeometry(0.7, 1.0, 0.02)

const PARTICLE_COUNT = 80
const particleGeo = new BufferGeometry()
const positions = new Float32Array(PARTICLE_COUNT * 3)
for (let i = 0; i < PARTICLE_COUNT; i++) {
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(2 * Math.random() - 1)
  const r = 2.2 + Math.random() * 0.6
  positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
  positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
  positions[i * 3 + 2] = r * Math.cos(phi)
}
particleGeo.setAttribute('position', new Float32BufferAttribute(positions, 3))

// ---------- Materials ----------
// Core — same style as rings: emissive glow with subtle sheen
const coreMat = new MeshStandardMaterial({
  color: 0x737373,
  emissive: 0x737373,
  emissiveIntensity: 0.45,
  roughness: 0.45,
  metalness: 0.3,
})

// Rings — subtle sheen, not chrome
const ringMats = Array.from({ length: RING_COUNT }, () =>
  new MeshStandardMaterial({
    color: 0x737373,
    emissive: 0x737373,
    emissiveIntensity: 0.45,
    roughness: 0.45,
    metalness: 0.3,
  }),
)

const panelMat = new MeshStandardMaterial({
  color: 0x737373,
  emissive: 0x737373,
  emissiveIntensity: 0.3,
  roughness: 0.3,
  metalness: 0.5,
  transparent: true,
  opacity: 0.35,
})

const particleMat = new PointsMaterial({
  color: 0x737373,
  size: 0.04,
  transparent: true,
  opacity: 0.15,
  blending: AdditiveBlending,
  depthWrite: false,
})

// ---------- Camera orbit ----------
const cameraRef = shallowRef<PerspectiveCamera | null>(null)
const ORBIT_RADIUS = 6
const ORBIT_ELEVATION = -0.45   // slight low angle (negative = below center)
const ORBIT_SPEED_MAP: Record<string, number> = {
  IDLE: 0.06,
  PASSIVE: 0.06,
  HEARING: 0.08,
  LISTENING: 0.10,
  THINKING: 0.15,
  EXECUTING: 0.18,
  SPEAKING: 0.10,
}
let orbitAngle = 0
let orbitSpeed = 0.06
const lookTarget = new Vector3(0, 0.3, 0)

// ---------- Mesh refs ----------
const coreRef = shallowRef<Mesh | null>(null)
const ringRefs = Array.from({ length: RING_COUNT }, () => shallowRef<Mesh | null>(null))
const panelRef = shallowRef<Mesh | null>(null)
const particlesRef = shallowRef<Points | null>(null)

// Colored light refs — these paint the chrome core
const colorLight0Ref = shallowRef<PointLight | null>(null)
const colorLight1Ref = shallowRef<PointLight | null>(null)
const colorLight2Ref = shallowRef<PointLight | null>(null)

// Reusable Color instance (no per-frame alloc)
const tmpColor = new Color()
let elapsed = 0
let ringsSeeded = false
let smoothedEnergy = 0
let smoothedMicEnergy = 0

const bloomIntensity = ref(ap.bloomIntensity)

const { onBeforeRender } = useLoop()

onBeforeRender(({ delta }) => {
  const dt = Math.min(delta, 0.1)
  updateAp(dt)

  // Smooth audio energy to avoid jarring jumps
  const energyTarget = props.audioEnergy
  smoothedEnergy += (energyTarget - smoothedEnergy) * (1 - Math.exp(-12 * dt))
  const ae = smoothedEnergy

  // Smooth mic energy for HEARING/LISTENING states
  const micTarget = props.micEnergy
  smoothedMicEnergy += (micTarget - smoothedMicEnergy) * (1 - Math.exp(-12 * dt))
  const me = smoothedMicEnergy

  const isHearing = props.activeState === 'HEARING'
  const isListening = props.activeState === 'LISTENING'

  // Orbit camera — speed adapts to active state
  const cam = cameraRef.value
  if (cam) {
    const targetOrbitSpeed = ORBIT_SPEED_MAP[props.activeState] ?? 0.06
    orbitSpeed += (targetOrbitSpeed - orbitSpeed) * (1 - Math.exp(-4 * dt))
    orbitAngle += orbitSpeed * dt
    cam.position.x = Math.sin(orbitAngle) * ORBIT_RADIUS
    cam.position.z = Math.cos(orbitAngle) * ORBIT_RADIUS
    cam.position.y = ORBIT_ELEVATION * ORBIT_RADIUS
    cam.lookAt(lookTarget)
  }

  tmpColor.setRGB(ap.primaryR, ap.primaryG, ap.primaryB)

  elapsed += dt

  // Core — color + audio/mic energy boost
  coreMat.emissive.copy(tmpColor)
  coreMat.color.copy(tmpColor)
  const micIntensityBoost = isHearing ? me * 0.15 : isListening ? me * 0.3 : 0
  coreMat.emissiveIntensity = ap.coreIntensity + ae * 0.5 + micIntensityBoost

  // Core — spin, scale, distortion
  const core = coreRef.value
  if (core) {
    // Spin — fast rotation on multiple axes
    core.rotation.y += ap.coreSpin * dt
    core.rotation.x += ap.coreSpin * dt * 0.7

    const isSpeaking = props.activeState === 'SPEAKING'

    // Extra speech-driven spin during SPEAKING
    if (isSpeaking) {
      core.rotation.y += ae * 2.0 * dt
    }

    // Gentle attentive spin during LISTENING — the avatar is paying attention
    if (isListening) {
      core.rotation.y += me * 0.8 * dt
    }

    // Distort — non-uniform scale wobble (3 out-of-phase sine waves)
    const d = ap.coreDistort
    const micScaleBoost = isHearing ? me * 0.05 : isListening ? me * 0.10 : 0
    const s = ap.coreScale + ae * 0.15 + micScaleBoost
    if (d > 0.01) {
      const t = elapsed * 8
      const sx = s + Math.sin(t * 2.3) * d
      const sy = s + Math.sin(t * 3.1 + 1.0) * d
      const sz = s + Math.sin(t * 1.7 + 2.0) * d
      if (isSpeaking) {
        // Stretch Y with audio energy for a "speaking" mouth effect
        core.scale.set(sx, sy + ae * 0.3, sz)
      } else if (isListening) {
        // Subtle Y-pulse during LISTENING — "breathing" in the user's voice
        core.scale.set(sx, sy + me * 0.12, sz)
      } else {
        core.scale.set(sx, sy, sz)
      }
    } else {
      // Smooth back to uniform scale
      core.scale.x += (s - core.scale.x) * 0.1
      core.scale.y += (s - core.scale.y) * 0.1
      core.scale.z += (s - core.scale.z) * 0.1
    }

    // Morph sphere → diamond or hexagon based on coreMorph and coreShape
    const m = ap.coreMorph
    const sh = ap.coreShape
    if (Math.abs(m - lastMorph) > 0.001 || Math.abs(sh - lastShape) > 0.001) {
      lastMorph = m
      lastShape = sh
      const pos = coreGeo.attributes['position']!.array as Float32Array
      for (let i = 0; i < pos.length; i++) {
        // Blend between diamond and hex targets based on coreShape
        const target = diamondPositions[i]! + (hexPositions[i]! - diamondPositions[i]!) * sh
        pos[i] = spherePositions[i]! + (target - spherePositions[i]!) * m
      }
      coreGeo.attributes['position']!.needsUpdate = true
      coreGeo.computeVertexNormals()
    }
  }

  // Colored lights
  const intensity = ap.coreIntensity * 3
  const cl0 = colorLight0Ref.value
  if (cl0) { cl0.color.copy(tmpColor); cl0.intensity = intensity }
  const cl1 = colorLight1Ref.value
  if (cl1) { cl1.color.copy(tmpColor); cl1.intensity = intensity * 0.8 }
  const cl2 = colorLight2Ref.value
  if (cl2) { cl2.color.copy(tmpColor); cl2.intensity = intensity * 0.6 }

  // Rings — seed starting rotations once
  if (!ringsSeeded && ringRefs[0]?.value) {
    ringsSeeded = true
    for (let i = 0; i < RING_COUNT; i++) {
      const r = ringRefs[i]?.value
      const c = ringConfigs[i]
      if (r && c) r.rotation.z = c[4]
    }
  }

  // Rings — boost speed with audio/mic energy
  const micRingBoost = isHearing ? me * 0.15 : isListening ? me * 0.3 : 0
  const ringSpeedMul = props.activeState === 'SPEAKING' ? 1 + ae * 0.5 : 1 + micRingBoost
  for (let i = 0; i < RING_COUNT; i++) {
    const ring = ringRefs[i]?.value
    if (!ring) continue
    const cfg = ringConfigs[i]
    if (!cfg) continue
    ring.rotation.z += ap.ringSpeed * dt * cfg[2] * cfg[3] * ringSpeedMul
    ring.rotation.x = cfg[0]
    ring.rotation.y = cfg[1]
    const mat = ringMats[i]
    if (!mat) continue
    mat.emissive.copy(tmpColor)
    mat.color.copy(tmpColor)
    mat.emissiveIntensity = ap.coreIntensity * 0.5
  }

  // Panel
  const panel = panelRef.value
  if (panel) {
    if (ap.panelFlipping > 0.5) {
      panel.rotation.y += dt * 1.5
    } else {
      panel.rotation.y *= 0.95
    }
    panelMat.emissive.copy(tmpColor)
    panelMat.color.copy(tmpColor)
    panelMat.emissiveIntensity = ap.coreIntensity * 0.3
    panelMat.opacity = 0.15 + ap.panelFlipping * 0.25
  }

  // Particles — modulated by audio energy (SPEAKING) and mic energy (HEARING/LISTENING)
  const micParticleBoost = isHearing ? me * 0.1 : isListening ? me * 0.2 : 0
  const pts = particlesRef.value
  if (pts) {
    pts.rotation.y += ap.particleSpeed * dt * 0.5
    pts.rotation.x += ap.particleSpeed * dt * 0.2
    particleMat.color.copy(tmpColor)
    particleMat.opacity = ap.particleOpacity + ae * 0.3 + micParticleBoost
  }

  // Bloom — modulated by audio energy (SPEAKING) and mic energy (HEARING/LISTENING)
  const micBloomBoost = isHearing ? me * 0.12 : isListening ? me * 0.2 : 0
  bloomIntensity.value = ap.bloomIntensity + ae * 0.3 + micBloomBoost
})
</script>

<template>
  <!-- Orbiting camera — slow continuous loop around the scene -->
  <TresPerspectiveCamera ref="cameraRef" :position="[0, -2.7, 6]" :fov="45" />

  <!-- Lighting -->
  <TresAmbientLight :intensity="0.08" />
  <!-- White key light — keeps chrome readable even in IDLE -->
  <TresPointLight :position="[3, 4, 3]" :intensity="0.4" />

  <!-- Colored lights — close to core for broad color washes on glossy surface -->
  <TresPointLight ref="colorLight0Ref" :position="[0.9, 0.9, 1.2]" :intensity="1" />
  <TresPointLight ref="colorLight1Ref" :position="[-1.1, 0.3, 0.8]" :intensity="0.7" />
  <TresPointLight ref="colorLight2Ref" :position="[0.2, -0.8, -1.0]" :intensity="0.5" />

  <!-- Core sphere -->
  <TresMesh
    ref="coreRef"
    :geometry="coreGeo"
    :material="coreMat"
  />

  <!-- Ring segments -->
  <TresMesh
    v-for="(geo, idx) in ringGeos"
    :key="`ring-${idx}`"
    :ref="(el) => { ringRefs[idx]!.value = el as unknown as Mesh | null }"
    :geometry="geo"
    :material="ringMats[idx] ?? coreMat"
  />

  <!-- Rectangular panel -->
  <TresMesh
    ref="panelRef"
    :geometry="panelGeo"
    :material="panelMat"
  />

  <!-- Floating particles -->
  <TresPoints
    ref="particlesRef"
    :geometry="particleGeo"
    :material="particleMat"
  />

  <!-- Post-processing -->
  <Suspense>
    <EffectComposerPmndrs>
      <BloomPmndrs
        :intensity="bloomIntensity"
        :luminance-threshold="0.1"
        :luminance-smoothing="0.3"
        :mipmap-blur="true"
      />
    </EffectComposerPmndrs>
  </Suspense>
</template>
