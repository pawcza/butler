export type ShapeName = 'triangle' | 'cube' | 'ring' | 'infinity' | 'pi' | 'alpha' | 'omega'

export function generateShapePositions(shape: ShapeName, count: number): Float32Array {
  switch (shape) {
    case 'triangle': return generateTriangle(count)
    case 'cube': return generateCube(count)
    case 'ring': return generateRing(count)
    case 'infinity': return generateInfinity(count)
    case 'pi': return generatePi(count)
    case 'alpha': return generateAlpha(count)
    case 'omega': return generateOmega(count)
  }
}

/**
 * Wireframe equilateral triangle on the XY plane.
 * Particles along the 3 edges only.
 */
function generateTriangle(count: number): Float32Array {
  const positions = new Float32Array(count * 3)
  const size = 1.2
  const h = size * Math.sqrt(3) / 2
  const thickness = 0.02

  // Three vertices of equilateral triangle, centered at origin
  const verts: [number, number][] = [
    [0, h * 2 / 3],          // top
    [-size / 2, -h / 3],     // bottom-left
    [size / 2, -h / 3],      // bottom-right
  ]

  const edges: [number, number][] = [[0, 1], [1, 2], [2, 0]]
  const perEdge = Math.floor(count / 3)
  let idx = 0

  for (let e = 0; e < 3; e++) {
    const n = e < count % 3 ? perEdge + 1 : perEdge
    const [ai, bi] = edges[e]!
    const a = verts[ai]!, b = verts[bi]!

    for (let j = 0; j < n && idx < count; j++) {
      const t = Math.random()
      positions[idx * 3] = a[0] + (b[0] - a[0]) * t + (Math.random() - 0.5) * thickness
      positions[idx * 3 + 1] = a[1] + (b[1] - a[1]) * t + (Math.random() - 0.5) * thickness
      positions[idx * 3 + 2] = (Math.random() - 0.5) * thickness
      idx++
    }
  }
  return positions
}

/**
 * Hollow cube — particles along the 12 edges only, giving a wireframe look
 * with a visible hole through the center.
 */
function generateCube(count: number): Float32Array {
  const positions = new Float32Array(count * 3)
  const h = 0.6
  const thickness = 0.03 // random scatter around each edge

  // 12 edges of a cube defined by vertex pairs
  const edges: [number, number, number, number, number, number][] = [
    // Bottom face (y = -h)
    [-h, -h, -h, h, -h, -h], [h, -h, -h, h, -h, h],
    [h, -h, h, -h, -h, h], [-h, -h, h, -h, -h, -h],
    // Top face (y = h)
    [-h, h, -h, h, h, -h], [h, h, -h, h, h, h],
    [h, h, h, -h, h, h], [-h, h, h, -h, h, -h],
    // Vertical edges
    [-h, -h, -h, -h, h, -h], [h, -h, -h, h, h, -h],
    [h, -h, h, h, h, h], [-h, -h, h, -h, h, h],
  ]

  const perEdge = Math.floor(count / 12)
  let idx = 0

  for (let e = 0; e < 12; e++) {
    const n = e < count % 12 ? perEdge + 1 : perEdge
    const edge = edges[e]!
    for (let j = 0; j < n && idx < count; j++) {
      const t = Math.random()
      positions[idx * 3] = edge[0]! + (edge[3]! - edge[0]!) * t + (Math.random() - 0.5) * thickness
      positions[idx * 3 + 1] = edge[1]! + (edge[4]! - edge[1]!) * t + (Math.random() - 0.5) * thickness
      positions[idx * 3 + 2] = edge[2]! + (edge[5]! - edge[2]!) * t + (Math.random() - 0.5) * thickness
      idx++
    }
  }
  return positions
}

/**
 * Torus (ring) using parametric surface sampling.
 * Major radius R = 0.8, minor radius r = 0.15.
 */
function generateRing(count: number): Float32Array {
  const positions = new Float32Array(count * 3)
  const R = 0.8
  const r = 0.15

  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2 // angle around the ring
    const phi = Math.random() * Math.PI * 2   // angle around the tube
    // Ring in XY plane (faces camera at Z=6 looking at origin)
    positions[i * 3] = (R + r * Math.cos(phi)) * Math.cos(theta)
    positions[i * 3 + 1] = (R + r * Math.cos(phi)) * Math.sin(theta)
    positions[i * 3 + 2] = r * Math.sin(phi) // tube depth goes into Z
  }
  return positions
}

/**
 * Infinity sign (lemniscate of Bernoulli) as a tube wireframe in the XY plane.
 * Parametric: x = a * cos(t) / (1 + sin²(t)), y = a * sin(t) * cos(t) / (1 + sin²(t))
 * Particles distributed along the curve with a small tube radius for thickness.
 */
function generateInfinity(count: number): Float32Array {
  const positions = new Float32Array(count * 3)
  const a = 0.9      // overall size
  const tube = 0.06  // tube radius for visible thickness

  for (let i = 0; i < count; i++) {
    const t = Math.random() * Math.PI * 2
    const sinT = Math.sin(t)
    const denom = 1 + sinT * sinT
    // Lemniscate curve in XY plane
    const cx = a * Math.cos(t) / denom
    const cy = a * sinT * Math.cos(t) / denom
    // Random offset within tube cross-section
    const tubeAngle = Math.random() * Math.PI * 2
    const tubeR = Math.random() * tube
    // Tube expands in Y and Z (perpendicular to the curve in XY)
    positions[i * 3] = cx + (Math.random() - 0.5) * tube * 0.3
    positions[i * 3 + 1] = cy + tubeR * Math.cos(tubeAngle)
    positions[i * 3 + 2] = tubeR * Math.sin(tubeAngle)
  }
  return positions
}

/**
 * Pi (π) symbol — horizontal bar with two vertical legs.
 * Wireframe style, particles along three line segments.
 */
function generatePi(count: number): Float32Array {
  const positions = new Float32Array(count * 3)
  const thickness = 0.02
  const barWidth = 1.1
  const legHeight = 0.9
  const barY = 0.45

  // Three segments: horizontal bar, left leg, right leg
  const segments: [number, number, number, number][] = [
    [-barWidth / 2, barY, barWidth / 2, barY],
    [-barWidth * 0.28, barY, -barWidth * 0.28, barY - legHeight],
    [barWidth * 0.28, barY, barWidth * 0.28, barY - legHeight],
  ]

  const perSeg = Math.floor(count / 3)
  let idx = 0

  for (let s = 0; s < 3; s++) {
    const n = s < count % 3 ? perSeg + 1 : perSeg
    const seg = segments[s]!
    for (let j = 0; j < n && idx < count; j++) {
      const t = Math.random()
      positions[idx * 3] = seg[0] + (seg[2] - seg[0]) * t + (Math.random() - 0.5) * thickness
      positions[idx * 3 + 1] = seg[1] + (seg[3] - seg[1]) * t + (Math.random() - 0.5) * thickness
      positions[idx * 3 + 2] = (Math.random() - 0.5) * thickness
      idx++
    }
  }
  return positions
}

/**
 * Alpha (α) symbol — a circle (bowl) with a tail curving upward-right.
 */
function generateAlpha(count: number): Float32Array {
  const positions = new Float32Array(count * 3)
  const r = 0.5
  const thickness = 0.02

  const circleCount = Math.floor(count * 0.75)
  let idx = 0

  // Full circle (the bowl)
  for (let i = 0; i < circleCount && idx < count; i++) {
    const angle = Math.random() * Math.PI * 2
    positions[idx * 3] = r * Math.cos(angle) + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 1] = r * Math.sin(angle) + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 2] = (Math.random() - 0.5) * thickness
    idx++
  }

  // Tail: from right side of circle, curves upward
  const tailCount = count - circleCount
  for (let i = 0; i < tailCount && idx < count; i++) {
    const t = Math.random()
    positions[idx * 3] = r + t * 0.3 + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 1] = t * t * 0.5 + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 2] = (Math.random() - 0.5) * thickness
    idx++
  }
  return positions
}

/**
 * Omega (Ω) symbol — a 240° arc (open at bottom) with two horizontal feet.
 */
function generateOmega(count: number): Float32Array {
  const positions = new Float32Array(count * 3)
  const r = 0.7
  const thickness = 0.02
  const footLen = 0.25

  const arcCount = Math.floor(count * 0.7)
  const footCount = Math.floor((count - arcCount) / 2)
  let idx = 0

  // Arc: 240° from bottom-right (-30°) counterclockwise to bottom-left (210°)
  const arcStart = -30 * Math.PI / 180
  const arcSpan = 240 * Math.PI / 180

  for (let i = 0; i < arcCount && idx < count; i++) {
    const angle = arcStart + Math.random() * arcSpan
    positions[idx * 3] = r * Math.cos(angle) + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 1] = r * Math.sin(angle) + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 2] = (Math.random() - 0.5) * thickness
    idx++
  }

  // Right foot: extends rightward from bottom-right endpoint
  const rightEndX = r * Math.cos(arcStart)
  const rightEndY = r * Math.sin(arcStart)
  for (let i = 0; i < footCount && idx < count; i++) {
    const t = Math.random()
    positions[idx * 3] = rightEndX + t * footLen + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 1] = rightEndY + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 2] = (Math.random() - 0.5) * thickness
    idx++
  }

  // Left foot: extends leftward from bottom-left endpoint
  const leftEndX = r * Math.cos(arcStart + arcSpan)
  const leftEndY = r * Math.sin(arcStart + arcSpan)
  for (let i = 0; i < footCount && idx < count; i++) {
    const t = Math.random()
    positions[idx * 3] = leftEndX - t * footLen + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 1] = leftEndY + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 2] = (Math.random() - 0.5) * thickness
    idx++
  }

  // Fill remaining from rounding
  while (idx < count) {
    const angle = arcStart + Math.random() * arcSpan
    positions[idx * 3] = r * Math.cos(angle) + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 1] = r * Math.sin(angle) + (Math.random() - 0.5) * thickness
    positions[idx * 3 + 2] = (Math.random() - 0.5) * thickness
    idx++
  }
  return positions
}
