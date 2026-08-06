import { describe, it, expect } from 'vitest'
import {
  COLUMN_WIDTH_DEFAULT,
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  clampColumnWidth,
  widthFromStored,
} from '../../src/renderer/lib/columnWidth'

/**
 * The two pure halves of the column-width preference. `useColumnWidth` itself
 * is not tested here: `vitest.config.mts` runs in `environment: 'node'`, where
 * there is no `localStorage` and no React to render into. What CAN be tested
 * without either is the arithmetic that decides what a drag is allowed to
 * reach and what a stored value means, which is where the failures live: a
 * drag past a bound and a hand-edited entry.
 */

describe('clampColumnWidth', () => {
  it('keeps a width that is already inside the bounds, rounded to a pixel', () => {
    expect(clampColumnWidth(300)).toBe(300)
    // Rounded because this becomes a CSS pixel width and a drag produces
    // fractional client coordinates on a scaled display.
    expect(clampColumnWidth(300.6)).toBe(301)
  })

  it('holds a drag at the floor rather than letting a column vanish', () => {
    expect(clampColumnWidth(0)).toBe(COLUMN_WIDTH_MIN)
    // Negative is reachable: a right-hand column's width is `base - delta`, so
    // dragging far enough past the edge produces one.
    expect(clampColumnWidth(-4000)).toBe(COLUMN_WIDTH_MIN)
  })

  it('holds a drag at the ceiling rather than letting one column eat the window', () => {
    expect(clampColumnWidth(4000)).toBe(COLUMN_WIDTH_MAX)
  })

  it('reads a non-finite width as the default', () => {
    // `NaN` is what an unmeasured element or a divide by zero would produce,
    // and `Math.max(MIN, NaN)` is NaN, which would render as no width at all.
    expect(clampColumnWidth(Number.NaN)).toBe(COLUMN_WIDTH_DEFAULT)
    expect(clampColumnWidth(Number.POSITIVE_INFINITY)).toBe(COLUMN_WIDTH_DEFAULT)
  })
})

describe('widthFromStored', () => {
  it('falls back when nothing is stored, and honours a per-column fallback', () => {
    expect(widthFromStored(null)).toBe(COLUMN_WIDTH_DEFAULT)
    // Notes passes 256, the `w-64` it held before it was adjustable.
    expect(widthFromStored(null, 256)).toBe(256)
  })

  it('falls back for junk rather than throwing or reading it as a number', () => {
    expect(widthFromStored('wide', 256)).toBe(256)
    // `Number('')` is 0, which is finite and would clamp to the floor. An empty
    // entry is a missing one, and this is the assertion that says so.
    expect(widthFromStored('', 256)).toBe(256)
    expect(widthFromStored('   ', 256)).toBe(256)
  })

  it('clamps a stored value that is out of bounds', () => {
    // Reachable by hand editing, and by a bound that is lowered in a later
    // version under a profile written by an earlier one.
    expect(widthFromStored(String(COLUMN_WIDTH_MAX + 500))).toBe(COLUMN_WIDTH_MAX)
    expect(widthFromStored('10')).toBe(COLUMN_WIDTH_MIN)
  })

  it('roundtrips a width the way the hook writes it', () => {
    // The hook stores `String(width)`, so this is the real pairing rather than
    // a chosen one.
    expect(widthFromStored(String(clampColumnWidth(377)))).toBe(377)
  })
})
