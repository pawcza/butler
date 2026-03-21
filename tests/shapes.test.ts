import { describe, it, expect } from 'vitest'
import { generateShapePositions, type ShapeName } from '../utils/shapes'

const SHAPES: ShapeName[] = ['triangle', 'cube', 'ring', 'infinity', 'pi', 'alpha', 'omega']

describe('generateShapePositions', () => {
  for (const shape of SHAPES) {
    describe(shape, () => {
      it('returns Float32Array with 3 floats per point', () => {
        const count = 100
        const result = generateShapePositions(shape, count)
        expect(result).toBeInstanceOf(Float32Array)
        expect(result.length).toBe(count * 3)
      })

      it('generates points within a bounding radius of 2.0', () => {
        const result = generateShapePositions(shape, 500)
        for (let i = 0; i < result.length; i += 3) {
          const x = result[i]!
          const y = result[i + 1]!
          const z = result[i + 2]!
          const r = Math.sqrt(x * x + y * y + z * z)
          expect(r).toBeLessThan(2.0)
        }
      })

      it('produces no NaN values', () => {
        const result = generateShapePositions(shape, 500)
        for (let i = 0; i < result.length; i++) {
          expect(Number.isNaN(result[i])).toBe(false)
        }
      })

      it('handles count of 0', () => {
        const result = generateShapePositions(shape, 0)
        expect(result.length).toBe(0)
      })
    })
  }

  it('cube distributes points across all 6 faces', () => {
    const result = generateShapePositions('cube', 600)
    const half = 0.6
    const tolerance = 0.01
    const hasFace = [false, false, false, false, false, false]
    for (let i = 0; i < result.length; i += 3) {
      const x = result[i]!, y = result[i + 1]!, z = result[i + 2]!
      if (Math.abs(x - half) < tolerance) hasFace[0] = true
      if (Math.abs(x + half) < tolerance) hasFace[1] = true
      if (Math.abs(y - half) < tolerance) hasFace[2] = true
      if (Math.abs(y + half) < tolerance) hasFace[3] = true
      if (Math.abs(z - half) < tolerance) hasFace[4] = true
      if (Math.abs(z + half) < tolerance) hasFace[5] = true
    }
    expect(hasFace.filter(Boolean).length).toBe(6)
  })
})
