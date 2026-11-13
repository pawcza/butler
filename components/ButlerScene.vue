<script setup lang="ts">
import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three'
import { generateShapePositions, type ShapeName } from '~/utils/shapes'
import { knnPairs, LineSet } from '~/utils/plexus'

import positionChunk from '~/shaders/position.glsl?raw'
import particlesVert from '~/shaders/particles.vert.glsl?raw'
import particlesFrag from '~/shaders/particles.frag.glsl?raw'
import linesVert from '~/shaders/lines.vert.glsl?raw'
import linesFrag from '~/shaders/lines.frag.glsl?raw'

// ---------- Props ----------
const props = withDefaults(defineProps<{
  activeState: string
  audioEnergy?: number
}>(), {
  audioEnergy: 0,
})

// ---------- Performance tier (one-time at init) ----------
// A few thousand points and lines are cheap everywhere; only phones get fewer points and a lower DPR.
const isMobile = typeof window !== 'undefined' && (
  window.matchMedia('(pointer: coarse)').matches ||
  window.innerWidth < 768 ||
  window.innerHeight < 768
)

const PARTICLE_COUNT = isMobile ? 800 : 1500
const SHAPE_POINT_COUNT = isMobile ? 240 : 380
const SHAPE_SCALE = isMobile ? 0.9 : 1.5 // shapes are authored around 1 unit; this makes them fill the view
const NEIGHBOURS = 3
const GALAXY_RADIUS = 5
const GALAXY_SQUASH = [1, 0.65, 0.9] as const // the view is wider than tall, so flatten the cloud
const HOME_LINK_MAX = 2.0   // longest link kept in the loose layout
const HOME_LINK_FADE = 1.6  // distance at which a loose link has faded out
const SHAPE_LINK_MAX = 0.55 * SHAPE_SCALE
const SHAPE_LINK_FADE = 0.43 * SHAPE_SCALE

const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1
const dpr = Math.min(rawDpr, isMobile ? 1.5 : 2)

// ---------- Avatar state composable ----------
const activeStateRef = toRef(props, 'activeState')
const { current: ap, update: updateAp, initialShape } = useAvatarState(activeStateRef)

// ---------- Home positions: an even, loose constellation ----------
// Best-candidate sampling keeps points from clumping, so nearest-neighbour links look deliberate.
// The sqrt radius gives a mild centre bias so shapes pull from a denser core.
function randomHome(out: Float32Array, i: number): void {
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(2 * Math.random() - 1)
  const r = Math.sqrt(Math.random()) * GALAXY_RADIUS
  out[i * 3] = r * Math.sin(phi) * Math.cos(theta) * GALAXY_SQUASH[0]
  out[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * GALAXY_SQUASH[1]
  out[i * 3 + 2] = r * Math.cos(phi) * GALAXY_SQUASH[2]
}

const homePositions = new Float32Array(PARTICLE_COUNT * 3)
{
  const candidate = new Float32Array(3)
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    let bestMin = -1
    for (let c = 0; c < 4; c++) {
      randomHome(candidate, 0)
      let minSq = Infinity
      for (let j = 0; j < i; j++) {
        const dx = homePositions[j * 3]! - candidate[0]!
        const dy = homePositions[j * 3 + 1]! - candidate[1]!
        const dz = homePositions[j * 3 + 2]! - candidate[2]!
        const dSq = dx * dx + dy * dy + dz * dz
        if (dSq < minSq) minSq = dSq
      }
      if (minSq > bestMin) {
        bestMin = minSq
        homePositions.set(candidate, i * 3)
      }
    }
  }
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
const slotToParticle = new Uint32Array(SHAPE_POINT_COUNT)
for (let rank = 0; rank < SHAPE_POINT_COUNT; rank++) {
  const idx = sortedByDist[rank]!
  assigned[idx] = 1.0
  particleToSlot[idx] = rank
  slotToParticle[rank] = idx
}

// ---------- Pre-generate all 7 shapes, and the links inside each ----------
const SHAPE_NAMES: ShapeName[] = ['triangle', 'cube', 'ring', 'infinity', 'pi', 'alpha', 'omega']
const shapePositions = {} as Record<ShapeName, Float32Array>
// Links as particle index pairs, ready for the line geometry
const shapePairs = {} as Record<ShapeName, Uint32Array>
let maxShapePairs = 0
for (const name of SHAPE_NAMES) {
  const positions = generateShapePositions(name, SHAPE_POINT_COUNT)
  for (let i = 0; i < positions.length; i++) positions[i] = positions[i]! * SHAPE_SCALE
  shapePositions[name] = positions
  const slotPairs = knnPairs(positions, NEIGHBOURS, SHAPE_LINK_MAX)
  const pairs = new Uint32Array(slotPairs.length)
  for (let i = 0; i < slotPairs.length; i++) pairs[i] = slotToParticle[slotPairs[i]!]!
  shapePairs[name] = pairs
  maxShapePairs = Math.max(maxShapePairs, pairs.length / 2)
}
const homePairs = knnPairs(homePositions, NEIGHBOURS, HOME_LINK_MAX)

// ---------- Shape buffers (from/to for morphing) ----------
// Each particle's shape target is determined by particleToSlot mapping.
// Floaters (slot = -1) get 0,0,0 — doesn't matter, shader ignores them.
const fromArray = new Float32Array(PARTICLE_COUNT * 3)
const toArray = new Float32Array(PARTICLE_COUNT * 3)
// Start from the shape the avatar is already in, so a scene mounted mid-turn doesn't flash the ring.
const seedShape: ShapeName = initialShape ?? 'ring'
const defaultShape = shapePositions[seedShape]
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

// ---------- Point geometry ----------
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

// ---------- Line geometry ----------
// Loose links never change; shape links are swapped each time the shape changes.
const linePoints = { home: homePositions, from: fromArray, to: toArray, phase: phases, assigned }
const homeLines = new LineSet(linePoints, homePairs.length / 2)
homeLines.setPairs(homePairs)
const shapeLines = new LineSet(linePoints, maxShapePairs)
shapeLines.setPairs(shapePairs[seedShape])

// ---------- Materials ----------
// One set of uniform objects shared by points and both line sets, updated once per frame.
const shared = {
  u_time: { value: 0 },
  u_condense: { value: 0 },
  u_shapeMorph: { value: 1 },
  u_wobbleAmount: { value: ap.wobbleAmount },
  u_energy: { value: 0 },
  u_color: { value: new Vector3(ap.primaryR, ap.primaryG, ap.primaryB) },
}

const particleMat = new ShaderMaterial({
  vertexShader: `${positionChunk}\n${particlesVert}`,
  fragmentShader: particlesFrag,
  uniforms: {
    ...shared,
    u_pointSize: { value: (isMobile ? 0.085 : 0.075) * dpr },
    u_particleBrightness: { value: ap.particleBrightness },
  },
  transparent: true,
  depthTest: false,
  depthWrite: false,
})

function makeLineMaterial(kind: number, maxLen: number, lineOpacity: { value: number }): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: `${positionChunk}\n${linesVert}`,
    fragmentShader: linesFrag,
    uniforms: {
      ...shared,
      u_lineOpacity: lineOpacity,
      u_kind: { value: kind },
      u_maxLen: { value: maxLen },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
}
const looseLineOpacity = { value: ap.looseLineOpacity }
const shapeLineOpacity = { value: ap.shapeLineOpacity }
const homeLineMat = makeLineMaterial(0, HOME_LINK_FADE, looseLineOpacity)
const shapeLineMat = makeLineMaterial(1, SHAPE_LINK_FADE, shapeLineOpacity)

// ---------- Camera ----------
// Still: the drifting points are motion enough. It sits a little off-axis and above, so the
// condensed shapes read as 3D rather than flat.
const cameraRef = shallowRef<PerspectiveCamera | null>(null)
const CAMERA_DISTANCE = 6
const CAMERA_YAW = 0.55
const CAMERA_RISE = 1.8
const CAMERA_POSITION: [number, number, number] = [
  Math.sin(CAMERA_YAW) * CAMERA_DISTANCE,
  CAMERA_RISE,
  Math.cos(CAMERA_YAW) * CAMERA_DISTANCE,
]
const lookTarget = new Vector3(0, 0, 0)
watch(cameraRef, (cam) => cam?.lookAt(lookTarget))

// ---------- Render loop ----------
let elapsed = 0
let smoothedEnergy = 0

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
    homeLines.syncShape()
    shapeLines.setPairs(shapePairs[shapeChanged])
  }

  // --- Update uniforms ---
  shared.u_time.value = elapsed
  shared.u_condense.value = ap.condense
  shared.u_shapeMorph.value = ap.shapeMorph
  shared.u_wobbleAmount.value = ap.wobbleAmount
  shared.u_energy.value = smoothedEnergy
  shared.u_color.value.set(ap.primaryR, ap.primaryG, ap.primaryB)
  particleMat.uniforms['u_particleBrightness']!.value = ap.particleBrightness + smoothedEnergy * 0.2
  looseLineOpacity.value = ap.looseLineOpacity
  shapeLineOpacity.value = ap.shapeLineOpacity + smoothedEnergy * 0.15
})
</script>

<template>
  <TresPerspectiveCamera ref="cameraRef" :position="CAMERA_POSITION" :fov="45" />

  <TresLineSegments :geometry="homeLines.geometry" :material="homeLineMat" :frustum-culled="false" :render-order="0" />
  <TresLineSegments :geometry="shapeLines.geometry" :material="shapeLineMat" :frustum-culled="false" :render-order="1" />
  <TresPoints :geometry="particleGeo" :material="particleMat" :frustum-culled="false" :render-order="2" />
</template>
