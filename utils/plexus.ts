import { BufferAttribute, BufferGeometry, DynamicDrawUsage } from 'three'

/**
 * Nearest-neighbour pairs for the plexus lines.
 *
 * Every point is linked to its `k` closest points that lie within `maxDist`. A pair found from
 * both sides is kept once. Returns a flat array [a0, b0, a1, b1, ...] of point indices with a < b.
 * Brute force: this runs once per layout over a few hundred to ~1.5k points.
 */
export function knnPairs(positions: Float32Array, k: number, maxDist: number): Uint32Array {
  const n = Math.floor(positions.length / 3)
  const maxSq = maxDist * maxDist
  const seen = new Set<number>()
  const out: number[] = []
  const bestIdx = new Array<number>(k)
  const bestSq = new Array<number>(k)

  for (let i = 0; i < n; i++) {
    const ix = positions[i * 3]!, iy = positions[i * 3 + 1]!, iz = positions[i * 3 + 2]!
    let found = 0
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const dx = positions[j * 3]! - ix, dy = positions[j * 3 + 1]! - iy, dz = positions[j * 3 + 2]! - iz
      const dSq = dx * dx + dy * dy + dz * dz
      if (dSq > maxSq) continue
      if (found === k && dSq >= bestSq[k - 1]!) continue
      // Insert into the sorted shortlist
      let slot = found < k ? found++ : k - 1
      while (slot > 0 && bestSq[slot - 1]! > dSq) {
        bestSq[slot] = bestSq[slot - 1]!
        bestIdx[slot] = bestIdx[slot - 1]!
        slot--
      }
      bestSq[slot] = dSq
      bestIdx[slot] = j
    }
    for (let m = 0; m < found; m++) {
      const j = bestIdx[m]!
      const a = Math.min(i, j), b = Math.max(i, j)
      const key = a * n + b
      if (seen.has(key)) continue
      seen.add(key)
      out.push(a, b)
    }
  }
  return Uint32Array.from(out)
}

/** The per-particle attribute arrays shared with the point cloud. `from` and `to` are mutated live. */
export interface PointArrays {
  home: Float32Array
  from: Float32Array
  to: Float32Array
  phase: Float32Array
  assigned: Float32Array
}

/**
 * A LineSegments geometry whose vertices carry the same attributes as the points plus the other
 * endpoint's attributes (suffix `B`), so the line vertex shader can place both ends with the same
 * position function as the points and follow every morph on the GPU.
 */
export class LineSet {
  readonly geometry = new BufferGeometry()
  private readonly capacity: number
  private readonly points: PointArrays
  private readonly own: Record<'home' | 'from' | 'to' | 'phase' | 'assigned', BufferAttribute>
  private readonly other: Record<'home' | 'from' | 'to' | 'phase' | 'assigned', BufferAttribute>
  private pairs: Uint32Array = new Uint32Array(0)

  /** `capacityPairs` is the most pairs `setPairs` will ever be given. */
  constructor(points: PointArrays, capacityPairs: number) {
    this.points = points
    this.capacity = capacityPairs
    const v = capacityPairs * 2
    const make = (size: number, name: string, dynamic: boolean): BufferAttribute => {
      const attr = new BufferAttribute(new Float32Array(v * size), size)
      if (dynamic) attr.setUsage(DynamicDrawUsage)
      this.geometry.setAttribute(name, attr)
      return attr
    }
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(v * 3), 3))
    this.own = {
      home: make(3, 'a_homePosition', false),
      from: make(3, 'a_shapePositionFrom', true),
      to: make(3, 'a_shapePositionTo', true),
      phase: make(1, 'a_phase', false),
      assigned: make(1, 'a_assignedToShape', false),
    }
    this.other = {
      home: make(3, 'a_homePositionB', false),
      from: make(3, 'a_shapePositionFromB', true),
      to: make(3, 'a_shapePositionToB', true),
      phase: make(1, 'a_phaseB', false),
      assigned: make(1, 'a_assignedToShapeB', false),
    }
    this.geometry.setDrawRange(0, 0)
  }

  /** Replace the line list. `pairs` holds particle indices, as returned by `knnPairs` then mapped. */
  setPairs(pairs: Uint32Array): void {
    if (pairs.length / 2 > this.capacity) throw new Error('LineSet capacity exceeded')
    this.pairs = pairs
    const { home, phase, assigned } = this.points
    for (let p = 0; p < pairs.length / 2; p++) {
      const a = pairs[p * 2]!, b = pairs[p * 2 + 1]!
      for (let side = 0; side < 2; side++) {
        const i = side === 0 ? a : b
        const j = side === 0 ? b : a
        const vtx = p * 2 + side
        copy3(home, i, this.own.home.array as Float32Array, vtx)
        copy3(home, j, this.other.home.array as Float32Array, vtx)
        ;(this.own.phase.array as Float32Array)[vtx] = phase[i]!
        ;(this.other.phase.array as Float32Array)[vtx] = phase[j]!
        ;(this.own.assigned.array as Float32Array)[vtx] = assigned[i]!
        ;(this.other.assigned.array as Float32Array)[vtx] = assigned[j]!
      }
    }
    this.own.home.needsUpdate = true
    this.other.home.needsUpdate = true
    this.own.phase.needsUpdate = true
    this.other.phase.needsUpdate = true
    this.own.assigned.needsUpdate = true
    this.other.assigned.needsUpdate = true
    this.geometry.setDrawRange(0, pairs.length)
    this.syncShape()
  }

  /** Re-copy the live from/to shape slots after the shape buffers changed. */
  syncShape(): void {
    const { from, to } = this.points
    const pairs = this.pairs
    for (let p = 0; p < pairs.length / 2; p++) {
      const a = pairs[p * 2]!, b = pairs[p * 2 + 1]!
      copy3(from, a, this.own.from.array as Float32Array, p * 2)
      copy3(to, a, this.own.to.array as Float32Array, p * 2)
      copy3(from, b, this.other.from.array as Float32Array, p * 2)
      copy3(to, b, this.other.to.array as Float32Array, p * 2)
      copy3(from, b, this.own.from.array as Float32Array, p * 2 + 1)
      copy3(to, b, this.own.to.array as Float32Array, p * 2 + 1)
      copy3(from, a, this.other.from.array as Float32Array, p * 2 + 1)
      copy3(to, a, this.other.to.array as Float32Array, p * 2 + 1)
    }
    this.own.from.needsUpdate = true
    this.own.to.needsUpdate = true
    this.other.from.needsUpdate = true
    this.other.to.needsUpdate = true
  }
}

function copy3(src: Float32Array, srcIdx: number, dst: Float32Array, dstIdx: number): void {
  dst[dstIdx * 3] = src[srcIdx * 3]!
  dst[dstIdx * 3 + 1] = src[srcIdx * 3 + 1]!
  dst[dstIdx * 3 + 2] = src[srcIdx * 3 + 2]!
}
