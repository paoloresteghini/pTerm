import { describe, it, expect } from 'vitest'
import { PANE_COLORS, PANE_COLOR_DEFAULT, isPaneColor } from '../../src/shared/paneColors'
// Moved to `contrast.ts` when `syntaxColors.test.ts` came to need the same
// arithmetic. Same functions, unchanged; this file is still where they earned
// their place.
import { contrast } from './contrast'

/** xterm's foreground, fixed in `Terminal.tsx` and not offered as a choice. */
const TERM_FG = '#d4d4d8'

describe('the offered pane colours', () => {
  // The point of this file. Every entry is a terminal background, the
  // foreground over it is fixed, and nothing at the picker or in the store
  // checks legibility — `isPaneColor` only asks whether a value is IN the
  // list, so the list itself is the only place the rule can live. A seventh
  // colour added by eye is exactly how an unreadable pane would ship, and this
  // is what fails when one is.
  it('all keep xterm\'s fixed foreground at AAA contrast', () => {
    for (const color of PANE_COLORS) {
      expect(contrast(color, TERM_FG), `${color} against ${TERM_FG}`).toBeGreaterThanOrEqual(7)
    }
  })

  // Guards the number in `paneColors.ts`'s own docstring, which says the
  // lightest leaves 7.89:1 and that this is why the ramp stops there. It
  // earned its place immediately: that line first said 7.6, written by guess,
  // and this assertion is what disagreed.
  it('stops at a lightest that is only just above the bar', () => {
    const lightest = PANE_COLORS[PANE_COLORS.length - 1]
    expect(lightest).toBe('#38383d')
    expect(contrast(lightest, TERM_FG)).toBeCloseTo(7.89, 2)
  })

  it('offers the default first, so the picker has a way back', () => {
    expect(PANE_COLORS[0]).toBe(PANE_COLOR_DEFAULT)
    // `--color-bg` in index.css. Repeated here because a default that drifted
    // from the app background would show as a seam around every uncoloured
    // pane rather than as an error.
    expect(PANE_COLOR_DEFAULT).toBe('#09090b')
  })

  it('are all distinct', () => {
    expect(new Set(PANE_COLORS).size).toBe(PANE_COLORS.length)
  })

  describe('isPaneColor', () => {
    it('accepts every offered colour', () => {
      for (const color of PANE_COLORS) expect(isPaneColor(color)).toBe(true)
    })

    it('rejects a colour that is merely valid CSS', () => {
      expect(isPaneColor('#ffffff')).toBe(false)
      // Same colour, different spelling. The check is membership of the list,
      // not colour equality, so the store keeps one spelling on disk.
      expect(isPaneColor('#09090B')).toBe(false)
      expect(isPaneColor('black')).toBe(false)
    })

    it('rejects what is not a string at all', () => {
      expect(isPaneColor(17)).toBe(false)
      expect(isPaneColor(null)).toBe(false)
      expect(isPaneColor(undefined)).toBe(false)
    })
  })
})
