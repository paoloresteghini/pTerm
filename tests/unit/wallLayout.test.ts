import { describe, it, expect } from 'vitest'
import { cellRect } from '../../src/renderer/lib/wallLayout'

/**
 * Where a wall cell sits, as percentages of the terminal column.
 *
 * Pure, because `vitest.config.mts` runs `environment: 'node'`: the render that
 * spreads these onto a group's box belongs to `App.tsx` and to `wall.spec.ts`,
 * not here.
 *
 * Sabotage-checked (2026-08-17), each mutation applied and reverted by hand:
 * 1. dropped the final-row stretch (`inThisRow` always `perRow`): reddened
 *    "stretches a short final row to fill the width" and "tiles the column with
 *    no gap and no overlap", as expected.
 * 2. dropped the `Math.max(1, ...)` on `perRow`: reddened "clamps a column
 *    count below one", as expected.
 * 3. returned `top: '0%'` unconditionally: reddened "wraps onto a second row
 *    past the column count" and "stretches a short final row to fill the width",
 *    as expected.
 * All three landed on exactly the named test(s); none left the suite green.
 */

/** `left`/`width` as numbers, so a test can do arithmetic on a tiling. */
function box(index: number, count: number, columns: number) {
  const rect = cellRect(index, count, columns)
  return {
    left: Number.parseFloat(rect.left),
    top: Number.parseFloat(rect.top),
    width: Number.parseFloat(rect.width),
    height: Number.parseFloat(rect.height),
  }
}

describe('cellRect', () => {
  it('gives a single cell the whole column', () => {
    expect(cellRect(0, 1, 3)).toEqual({ left: '0%', top: '0%', width: '100%', height: '100%' })
  })

  it('splits three cells across three columns in one row', () => {
    expect(box(0, 3, 3)).toEqual({ left: 0, top: 0, width: 100 / 3, height: 100 })
    expect(box(1, 3, 3).left).toBeCloseTo(100 / 3, 3)
    expect(box(2, 3, 3).left).toBeCloseTo(200 / 3, 3)
  })

  it('wraps onto a second row past the column count', () => {
    expect(box(2, 4, 2)).toEqual({ left: 0, top: 50, width: 50, height: 50 })
    expect(box(3, 4, 2)).toEqual({ left: 50, top: 50, width: 50, height: 50 })
  })

  // The alternative leaves a hole where the row's missing cell would be, which
  // is dead space in a view whose whole purpose is fitting terminals on screen.
  it('stretches a short final row to fill the width', () => {
    expect(box(3, 5, 3)).toEqual({ left: 0, top: 50, width: 50, height: 50 })
    expect(box(4, 5, 3)).toEqual({ left: 50, top: 50, width: 50, height: 50 })
  })

  it('tiles the column with no gap and no overlap', () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const columns of [1, 2, 3, 4]) {
        let area = 0
        for (let index = 0; index < count; index++) {
          const rect = box(index, count, columns)
          area += (rect.width / 100) * (rect.height / 100)
        }
        expect(area).toBeCloseTo(1, 6)
      }
    }
  })

  // `Terminal.tsx:700` returns early on a zero-sized container, so a rect that
  // could be zero is a pane that never fits.
  it('never returns a zero width or height', () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const columns of [1, 2, 3, 4]) {
        for (let index = 0; index < count; index++) {
          const rect = box(index, count, columns)
          expect(rect.width).toBeGreaterThan(0)
          expect(rect.height).toBeGreaterThan(0)
        }
      }
    }
  })

  // A stored column count is a preference, and `wallSlots.ts` is the only
  // thing that validates one. This clamps rather than trusting its caller.
  it('clamps a column count below one', () => {
    expect(cellRect(0, 2, 0)).toEqual({ left: '0%', top: '0%', width: '100%', height: '50%' })
  })

  it('never gives a cell less than its share when columns exceed the count', () => {
    expect(box(0, 2, 4)).toEqual({ left: 0, top: 0, width: 50, height: 100 })
  })
})
