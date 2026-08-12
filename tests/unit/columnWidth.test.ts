import { describe, it, expect } from 'vitest'
import {
  COLUMN_WIDTH_DEFAULT,
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  MIN_TERMINAL_WIDTH,
  clampColumnWidth,
  columnWidthMax,
  widthFromStored,
} from '../../src/renderer/lib/columnWidth'

/**
 * The three pure halves of the column-width preference. `useColumnWidth` itself
 * is not tested here: `vitest.config.mts` runs in `environment: 'node'`, where
 * there is no `localStorage` and no React to render into. What CAN be tested
 * without either is the arithmetic that decides what a drag is allowed to
 * reach and what a stored value means, which is where the failures live: a
 * drag past a bound and a hand-edited entry.
 */

/** The window the app opens at (`src/main/index.ts`), and every existing
 *  test's viewport before this file made the ceiling a function of one. */
const DEFAULT_WINDOW = 1280

describe('columnWidthMax', () => {
  it('reduces to COLUMN_WIDTH_MAX on the window the app opens, unchanged from before this existed', () => {
    expect(columnWidthMax(DEFAULT_WINDOW)).toBe(COLUMN_WIDTH_MAX)
  })

  it('floors at COLUMN_WIDTH_MAX rather than shrinking below it on a squeezed window', () => {
    expect(columnWidthMax(416)).toBe(COLUMN_WIDTH_MAX)
    expect(columnWidthMax(0)).toBe(COLUMN_WIDTH_MAX)
  })

  it('grows with the window past the default, so a big display gets a genuinely wide column', () => {
    // A 49" ultrawide, roughly 5120px wide. Reserves COLUMN_WIDTH_MAX for the
    // sidebar at its own ceiling and MIN_TERMINAL_WIDTH for the terminal.
    expect(columnWidthMax(5120)).toBe(5120 - COLUMN_WIDTH_MAX - MIN_TERMINAL_WIDTH)
    expect(columnWidthMax(5120)).toBe(4400)
  })

  it('never lets a single column plus the reserved sidebar leave less than MIN_TERMINAL_WIDTH for the terminal, at or above the default window', () => {
    // Below DEFAULT_WINDOW the ceiling is the same flat COLUMN_WIDTH_MAX this
    // codebase has always used there, floor and all: this invariant is new
    // for windows this size and larger, not a claim about a squeezed one.
    for (const viewport of [DEFAULT_WINDOW, 1920, 2560, 3440, 5120]) {
      const max = columnWidthMax(viewport)
      expect(viewport - max - COLUMN_WIDTH_MAX).toBeGreaterThanOrEqual(MIN_TERMINAL_WIDTH)
    }
  })
})

describe('clampColumnWidth', () => {
  it('keeps a width that is already inside the bounds, rounded to a pixel', () => {
    expect(clampColumnWidth(300, DEFAULT_WINDOW)).toBe(300)
    // Rounded because this becomes a CSS pixel width and a drag produces
    // fractional client coordinates on a scaled display.
    expect(clampColumnWidth(300.6, DEFAULT_WINDOW)).toBe(301)
  })

  it('holds a drag at the floor rather than letting a column vanish', () => {
    expect(clampColumnWidth(0, DEFAULT_WINDOW)).toBe(COLUMN_WIDTH_MIN)
    // Negative is reachable: a right-hand column's width is `base - delta`, so
    // dragging far enough past the edge produces one.
    expect(clampColumnWidth(-4000, DEFAULT_WINDOW)).toBe(COLUMN_WIDTH_MIN)
  })

  it('holds a drag at the ceiling rather than letting one column eat the window', () => {
    expect(clampColumnWidth(4000, DEFAULT_WINDOW)).toBe(COLUMN_WIDTH_MAX)
  })

  it('holds a drag at a taller ceiling on a wider window, which is the fix this file exists for', () => {
    // Before `columnWidthMax`, this was clamped at the fixed 560 regardless of
    // the screen: the 49" monitor bug. 4000 is comfortably inside the 5120px
    // ceiling now, so it survives the clamp rather than being cut down to 560.
    expect(clampColumnWidth(4000, 5120)).toBe(4000)
    expect(clampColumnWidth(9000, 5120)).toBe(columnWidthMax(5120))
  })

  it('reads a non-finite width as the default', () => {
    // `NaN` is what an unmeasured element or a divide by zero would produce,
    // and `Math.max(MIN, NaN)` is NaN, which would render as no width at all.
    expect(clampColumnWidth(Number.NaN, DEFAULT_WINDOW)).toBe(COLUMN_WIDTH_DEFAULT)
    expect(clampColumnWidth(Number.POSITIVE_INFINITY, DEFAULT_WINDOW)).toBe(COLUMN_WIDTH_DEFAULT)
  })
})

describe('widthFromStored', () => {
  it('falls back when nothing is stored, and honours a per-column fallback', () => {
    expect(widthFromStored(null, DEFAULT_WINDOW)).toBe(COLUMN_WIDTH_DEFAULT)
    // Notes passes 256, the `w-64` it held before it was adjustable.
    expect(widthFromStored(null, DEFAULT_WINDOW, 256)).toBe(256)
  })

  it('falls back for junk rather than throwing or reading it as a number', () => {
    expect(widthFromStored('wide', DEFAULT_WINDOW, 256)).toBe(256)
    // `Number('')` is 0, which is finite and would clamp to the floor. An empty
    // entry is a missing one, and this is the assertion that says so.
    expect(widthFromStored('', DEFAULT_WINDOW, 256)).toBe(256)
    expect(widthFromStored('   ', DEFAULT_WINDOW, 256)).toBe(256)
  })

  it('clamps a stored value that is out of bounds for the window it is read back into', () => {
    // Reachable by hand editing, and by a bound that is lowered in a later
    // version under a profile written by an earlier one.
    expect(widthFromStored(String(COLUMN_WIDTH_MAX + 500), DEFAULT_WINDOW)).toBe(COLUMN_WIDTH_MAX)
    expect(widthFromStored('10', DEFAULT_WINDOW)).toBe(COLUMN_WIDTH_MIN)
  })

  it('clamps a width stored on a big screen down to what a small one can hold', () => {
    // A 2000px column, saved from a 49" monitor, read back on a 1280px laptop:
    // the stored value must not survive past what THIS window can give it.
    expect(widthFromStored('2000', DEFAULT_WINDOW)).toBe(COLUMN_WIDTH_MAX)
    expect(widthFromStored('2000', DEFAULT_WINDOW)).toBeLessThanOrEqual(DEFAULT_WINDOW)
  })

  it('lets a width stored on a big screen through unclamped when read back on one just as big', () => {
    expect(widthFromStored('2000', 5120)).toBe(2000)
  })

  it('roundtrips a width the way the hook writes it', () => {
    // The hook stores `String(width)`, so this is the real pairing rather than
    // a chosen one.
    expect(widthFromStored(String(clampColumnWidth(377, DEFAULT_WINDOW)), DEFAULT_WINDOW)).toBe(
      377,
    )
  })
})
