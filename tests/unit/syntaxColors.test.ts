import { describe, it, expect } from 'vitest'
import { SYNTAX_COLORS } from '../../src/renderer/lib/syntaxColors'
import { PANE_COLORS } from '../../src/shared/paneColors'
import { contrast } from './contrast'

/**
 * WCAG AA for normal text. The bar `syntaxColors.ts` states and this file
 * enforces, deliberately below the 7:1 `paneColors.test.ts` holds xterm's
 * foreground to; the reason is written at `SYNTAX_COLORS`.
 */
const BAR = 4.5

describe('the syntax palette', () => {
  /**
   * The point of this file, and the check this repo has wanted since a
   * light-background highlight style shipped into a near-black editor.
   *
   * Every colour against every pane, rather than against the default one: the
   * pane's right-click menu lets the user pick any of the six, so a palette
   * measured only against `#09090b` is measured against the easiest case. The
   * lightest, `#38383d`, is where this fails first.
   *
   * **Mutation measured 2026-08-05**: `comment` set to `#71717a`, a plausible
   * choice one step dimmer and the sort of edit that gets made by eye. This
   * test FAILED with
   *
   *     comment #71717a on #09090b: expected 4.116653754467922 to be greater
   *     than or equal to 4.5
   *
   * naming the role, the colour and the pane. Note WHICH pane it named: the
   * DEFAULT one, not the lightest. A colour that fails the bar on `#09090b`
   * fails it on all six, and the loop reports the first, so the message is not
   * evidence about `#38383d` even though that is where the margin is
   * thinnest. The test below it failed in the same run, at 2.41 against 4.55.
   * Both reverted after measuring.
   */
  it('keeps every colour at AA against every pane the user can pick', () => {
    for (const [role, color] of Object.entries(SYNTAX_COLORS)) {
      for (const pane of PANE_COLORS) {
        expect(contrast(color, pane), `${role} ${color} on ${pane}`).toBeGreaterThanOrEqual(BAR)
      }
    }
  })

  // The bar is a floor and not a target, so this records where the palette
  // actually sits: if a later edit drags everything down to scrape 4.5, the
  // test above still passes and this one says the headroom went. `comment` is
  // the intended floor, being the one entry that is meant to be dim.
  it('leaves the dim entry closest to the bar, and nothing below it', () => {
    const worst = (color: string): number => Math.min(...PANE_COLORS.map((p) => contrast(color, p)))
    const ranked = Object.entries(SYNTAX_COLORS).sort((a, b) => worst(a[1]) - worst(b[1]))
    expect(ranked[0][0]).toBe('comment')
    expect(worst(SYNTAX_COLORS.comment)).toBeCloseTo(4.55, 2)
  })

  // Legible and still indistinguishable is a real failure mode: nine pastels
  // that each clear the bar can converge into one pale wash. Contrast between
  // the colours THEMSELVES is the wrong measure for that (two very different
  // hues at the same lightness are near 1:1 against each other), so this asks
  // the cheap structural question instead.
  it('offers nine distinct colours, not one repeated', () => {
    const values = Object.values(SYNTAX_COLORS)
    expect(new Set(values).size).toBe(values.length)
    expect(values.length).toBe(9)
  })

  it('are all six-digit lowercase hex, the way PANE_COLORS are', () => {
    for (const [role, color] of Object.entries(SYNTAX_COLORS)) {
      expect(color, role).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})
