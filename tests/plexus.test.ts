import { describe, it, expect } from 'vitest'
import { knnPairs } from '../utils/plexus'

describe('knnPairs', () => {
  it('links neighbours along a line and keeps each pair once', () => {
    // Five points on the x axis, spacing 1
    const pts = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0])
    const pairs = knnPairs(pts, 1, 10)
    const set = new Set<string>()
    for (let i = 0; i < pairs.length; i += 2) {
      expect(pairs[i]!).toBeLessThan(pairs[i + 1]!)
      set.add(`${pairs[i]}-${pairs[i + 1]}`)
    }
    expect(set.size).toBe(pairs.length / 2)
    expect(set.has('0-1')).toBe(true)
    expect(set.has('3-4')).toBe(true)
    expect(set.has('0-4')).toBe(false)
  })

  it('drops links longer than maxDist', () => {
    const pts = new Float32Array([0, 0, 0, 5, 0, 0])
    expect(knnPairs(pts, 3, 1).length).toBe(0)
    expect(knnPairs(pts, 3, 6).length).toBe(2)
  })

  it('links at most k nearest per point', () => {
    const pts = new Float32Array(30)
    for (let i = 0; i < 10; i++) pts[i * 3] = i
    const pairs = knnPairs(pts, 2, 100)
    // Each of the 10 points asks for 2 neighbours, so there can be at most 20 pairs
    expect(pairs.length / 2).toBeLessThanOrEqual(20)
  })
})
