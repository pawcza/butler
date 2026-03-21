<script setup lang="ts">
import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  ShaderMaterial,
  PlaneGeometry,
  AdditiveBlending,
  Vector3,
  Vector2,
  type Points,
  type PerspectiveCamera,
} from 'three'
import { BloomPmndrs, ChromaticAberrationPmndrs, EffectComposerPmndrs } from '@tresjs/post-processing'
import { generateShapePositions, type ShapeName } from '~/utils/shapes'

import particlesVert from '~/shaders/particles.vert.glsl?raw'
import particlesFrag from '~/shaders/particles.frag.glsl?raw'
import starsVert from '~/shaders/stars.vert.glsl?raw'
import starsFrag from '~/shaders/stars.frag.glsl?raw'
import nebulaVert from '~/shaders/nebula.vert.glsl?raw'
import nebulaFrag from '~/shaders/nebula.frag.glsl?raw'

// ---------- Props ----------
const props = withDefaults(defineProps<{
  activeState: string
  audioEnergy?: number
}>(), {
  audioEnergy: 0,
})

// ---------- Performance tier (one-time at init) ----------
const isSmallScreen = typeof window !== 'undefined' && (window.innerWidth < 768 || window.innerHeight < 768)
const PARTICLE_COUNT = isSmallScreen ? 5000 : 12000
const STAR_COUNT = isSmallScreen ? 2000 : 4000
const SHAPE_POINT_COUNT = Math.floor(PARTICLE_COUNT * 0.35)
const GALAXY_RADIUS = 5.5

// ---------- Avatar state composable ----------
const activeStateRef = toRef(props, 'activeState')
const { current: ap, update: updateAp } = useAvatarState(activeStateRef)

// ---------- Home positions (mild center bias for shape density) ----------
// sqrt(random) gives density ∝ r — more particles near center so shapes
// look solid even at partial condense, while still reaching screen edges.
const homePositions = new Float32Array(PARTICLE_COUNT * 3)
for (let i = 0; i < PARTICLE_COUNT; i++) {
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(2 * Math.random() - 1)
  const r = Math.sqrt(Math.random()) * GALAXY_RADIUS
  homePositions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
  homePositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
  homePositions[i * 3 + 2] = r * Math.cos(phi)
}

// ---------- Assignment: closest particles to center form shapes ----------
// Sort all particles by distance to origin. The closest SHAPE_POINT_COUNT
// become shape particles — they get pulled in from wherever they are.
const phases = new Float32Array(PARTICLE_COUNT)
for (let i = 0; i < PARTICLE_COUNT; i++) phases[i] = Math.random()

const sortedByDist = Array.from({ length: PARTICLE_COUNT }, (_, i) => i)
  .sort((a, b) => {
    const ax = homePositions[a * 3]!, ay = homePositions[a * 3 + 1]!, az = homePositions[a * 3 + 2]!
    const bx = homePositions[b * 3]!, by = homePositions[b * 3 + 1]!, bz = homePositions[b * 3 + 2]!
    return (ax * ax + ay * ay + az * az) - (bx * bx + by * by + bz * bz)
  })

const assigned = new Float32Array(PARTICLE_COUNT)
// particleToSlot[i] = which shape slot particle i maps to (-1 = floater)
const particleToSlot = new Int32Array(PARTICLE_COUNT).fill(-1)
for (let rank = 0; rank < SHAPE_POINT_COUNT; rank++) {
  const idx = sortedByDist[rank]!
  assigned[idx] = 1.0
  particleToSlot[idx] = rank
}

// ---------- Pre-generate all 7 shapes ----------
const shapePositions: Record<ShapeName, Float32Array> = {
  triangle: generateShapePositions('triangle', SHAPE_POINT_COUNT),
  cube: generateShapePositions('cube', SHAPE_POINT_COUNT),
  ring: generateShapePositions('ring', SHAPE_POINT_COUNT),
  infinity: generateShapePositions('infinity', SHAPE_POINT_COUNT),
  pi: generateShapePositions('pi', SHAPE_POINT_COUNT),
  alpha: generateShapePositions('alpha', SHAPE_POINT_COUNT),
  omega: generateShapePositions('omega', SHAPE_POINT_COUNT),
}

// ---------- Shape buffers (from/to for morphing) ----------
// Each particle's shape target is determined by particleToSlot mapping.
// Floaters (slot = -1) get 0,0,0 — doesn't matter, shader ignores them.
const fromArray = new Float32Array(PARTICLE_COUNT * 3)
const toArray = new Float32Array(PARTICLE_COUNT * 3)
const defaultShape = shapePositions.ring
for (let i = 0; i < PARTICLE_COUNT; i++) {
  const slot = particleToSlot[i]!
  if (slot >= 0) {
    fromArray[i * 3] = defaultShape[slot * 3] ?? 0
    fromArray[i * 3 + 1] = defaultShape[slot * 3 + 1] ?? 0
    fromArray[i * 3 + 2] = defaultShape[slot * 3 + 2] ?? 0
    toArray[i * 3] = defaultShape[slot * 3] ?? 0
    toArray[i * 3 + 1] = defaultShape[slot * 3 + 1] ?? 0
    toArray[i * 3 + 2] = defaultShape[slot * 3 + 2] ?? 0
  }
}

// ---------- Star field geometry + material ----------
const starGeo = new BufferGeometry()
const starPositions = new Float32Array(STAR_COUNT * 3)
const starBrightness = new Float32Array(STAR_COUNT)
const starPhases = new Float32Array(STAR_COUNT)
const STAR_RADIUS = 50
const BRIGHT_STAR_COUNT = 50

for (let i = 0; i < STAR_COUNT; i++) {
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(2 * Math.random() - 1)
  starPositions[i * 3] = STAR_RADIUS * Math.sin(phi) * Math.cos(theta)
  starPositions[i * 3 + 1] = STAR_RADIUS * Math.sin(phi) * Math.sin(theta)
  starPositions[i * 3 + 2] = STAR_RADIUS * Math.cos(phi)
  starBrightness[i] = i < BRIGHT_STAR_COUNT ? 0.8 + Math.random() * 0.2 : 0.05 + Math.random() * 0.25
  starPhases[i] = Math.random()
}
starGeo.setAttribute('position', new Float32BufferAttribute(starPositions, 3))
starGeo.setAttribute('a_brightness', new Float32BufferAttribute(starBrightness, 1))
starGeo.setAttribute('a_phase', new Float32BufferAttribute(starPhases, 1))

const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1
const starMat = new ShaderMaterial({
  vertexShader: starsVert,
  fragmentShader: starsFrag,
  uniforms: {
    u_time: { value: 0 },
    u_pointSize: { value: 1.5 * dpr },
  },
  transparent: true,
  depthWrite: false,
})

// ---------- Nebula quad geometry + material ----------
const nebulaGeo = new PlaneGeometry(2, 2)
const nebulaMat = new ShaderMaterial({
  vertexShader: nebulaVert,
  fragmentShader: nebulaFrag,
  uniforms: {
    u_time: { value: 0 },
    u_color: { value: [ap.primaryR, ap.primaryG, ap.primaryB] },
    u_intensity: { value: 0.08 },
  },
  transparent: true,
  depthTest: false,
  depthWrite: false,
})

// ---------- Main particle geometry + material ----------
const particleGeo = new BufferGeometry()
particleGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(PARTICLE_COUNT * 3), 3))
particleGeo.setAttribute('a_homePosition', new Float32BufferAttribute(homePositions, 3))

// Must use BufferAttribute (not Float32BufferAttribute) to keep the same
// array reference. Float32BufferAttribute copies the data, so render-loop
// writes to fromArray/toArray would never reach the GPU.
const fromAttr = new BufferAttribute(fromArray, 3)
const toAttr = new BufferAttribute(toArray, 3)
particleGeo.setAttribute('a_shapePositionFrom', fromAttr)
particleGeo.setAttribute('a_shapePositionTo', toAttr)
particleGeo.setAttribute('a_phase', new Float32BufferAttribute(phases, 1))
particleGeo.setAttribute('a_assignedToShape', new Float32BufferAttribute(assigned, 1))

const particleMat = new ShaderMaterial({
  vertexShader: particlesVert,
  fragmentShader: particlesFrag,
  uniforms: {
    u_time: { value: 0 },
    u_condense: { value: 0 },
    u_shapeMorph: { value: 1 },
    u_wobbleAmount: { value: ap.wobbleAmount },
    u_energy: { value: 0 },
    u_pointSize: { value: 0.8 * dpr },
    u_color: { value: [ap.primaryR, ap.primaryG, ap.primaryB] },
    u_particleBrightness: { value: ap.particleBrightness },
  },
  transparent: true,
  blending: AdditiveBlending,
  depthWrite: false,
})

// ---------- Camera orbit ----------
const cameraRef = shallowRef<PerspectiveCamera | null>(null)
const ORBIT_RADIUS = 6
const ORBIT_ELEVATION = 0
const ORBIT_SPEED_MAP: Record<string, number> = {
  IDLE: 0.03,
  LISTENING: 0.04,
  THINKING: 0.05,
  SPEAKING: 0.04,
  GRACE: 0.03,
}
let orbitAngle = 0
let orbitSpeed = 0.005
const lookTarget = new Vector3(0, 0, 0)

// ---------- Render loop ----------
let elapsed = 0
let smoothedEnergy = 0
const bloomIntensity = ref(ap.bloomIntensity)
const chromaticOffset = ref(new Vector2(0, 0))
const hazeIntensity = ref(0)
const hazeTime = ref(0)

const { onBeforeRender } = useLoop()

onBeforeRender(({ delta }) => {
  const dt = Math.min(delta, 0.1)
  const { shapeChanged } = updateAp(dt)
  elapsed += dt

  // Smooth audio energy — TTS playback drives outward pulse
  smoothedEnergy += (props.audioEnergy - smoothedEnergy) * (1 - Math.exp(-12 * dt))

  // --- Shape buffer swap ---
  if (shapeChanged) {
    fromArray.set(toArray)
    const newPositions = shapePositions[shapeChanged]
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const slot = particleToSlot[i]!
      if (slot >= 0) {
        toArray[i * 3] = newPositions[slot * 3] ?? 0
        toArray[i * 3 + 1] = newPositions[slot * 3 + 1] ?? 0
        toArray[i * 3 + 2] = newPositions[slot * 3 + 2] ?? 0
      }
    }
    fromAttr.needsUpdate = true
    toAttr.needsUpdate = true
  }

  // --- Update particle uniforms ---
  const pu = particleMat.uniforms
  pu['u_time']!.value = elapsed
  pu['u_condense']!.value = ap.condense
  pu['u_shapeMorph']!.value = ap.shapeMorph
  pu['u_wobbleAmount']!.value = ap.wobbleAmount
  pu['u_energy']!.value = smoothedEnergy
  pu['u_color']!.value = [ap.primaryR, ap.primaryG, ap.primaryB]
  pu['u_particleBrightness']!.value = ap.particleBrightness

  // --- Update star uniforms ---
  starMat.uniforms['u_time']!.value = elapsed

  // --- Update nebula uniforms ---
  const nu = nebulaMat.uniforms
  nu['u_time']!.value = elapsed
  nu['u_color']!.value = [ap.primaryR, ap.primaryG, ap.primaryB]
  nu['u_intensity']!.value = 0.02 + ap.condense * 0.02 + smoothedEnergy * 0.01

  // --- Camera orbit ---
  const cam = cameraRef.value
  if (cam) {
    const targetSpeed = ORBIT_SPEED_MAP[props.activeState] ?? 0.06
    orbitSpeed += (targetSpeed - orbitSpeed) * (1 - Math.exp(-4 * dt))
    orbitAngle += orbitSpeed * dt
    cam.position.x = Math.sin(orbitAngle) * ORBIT_RADIUS
    cam.position.z = Math.cos(orbitAngle) * ORBIT_RADIUS
    cam.position.y = ORBIT_ELEVATION * ORBIT_RADIUS
    cam.lookAt(lookTarget)
  }

  // --- Post-processing ---
  bloomIntensity.value = ap.bloomIntensity + smoothedEnergy * 0.1
  const ca = ap.chromaticIntensity + smoothedEnergy * 0.005
  chromaticOffset.value.set(
    Math.cos(elapsed) * ca,
    Math.sin(elapsed * 0.7) * ca,
  )
  hazeIntensity.value = ap.distortionIntensity + smoothedEnergy * 0.004
  hazeTime.value = elapsed
})
</script>

<template>
  <TresPerspectiveCamera ref="cameraRef" :position="[0, 0, 6]" :fov="45" />
  <TresAmbientLight :intensity="0.02" />

  <!-- Star field (background) -->
  <TresPoints :geometry="starGeo" :material="starMat" />

  <!-- Nebula fog (mid-ground, behind particles) -->
  <TresMesh :geometry="nebulaGeo" :material="nebulaMat" :render-order="-1" />

  <!-- Main particle system -->
  <TresPoints :geometry="particleGeo" :material="particleMat" />

  <Suspense>
    <EffectComposerPmndrs>
      <BloomPmndrs
        :intensity="bloomIntensity"
        :luminance-threshold="0.7"
        :luminance-smoothing="0.3"
        :mipmap-blur="true"
      />
      <ChromaticAberrationPmndrs
        :offset="chromaticOffset"
        :radial-modulation="true"
        :modulation-offset="0.3"
      />
      <HeatHazePmndrs
        :intensity="hazeIntensity"
        :time="hazeTime"
      />
    </EffectComposerPmndrs>
  </Suspense>
</template>
