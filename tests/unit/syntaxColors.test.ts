import { describe, it, expect } from 'vitest'
import { GUTTER_TEXT, SYNTAX_COLORS } from '../../src/renderer/lib/syntaxColors'
import { PANE_COLORS } from '../../src/shared/paneColors'
import { contrast } from './contrast'

/**
 * The house standard: what `paneColors.test.ts` measures `#d4d4d8` at against
 * the lightest pane, and what eight of the nine syntax colours are held to.
 */
const HOUSE_BAR = 7.89

/** WCAG AA for normal text. The floor for the one named exception below. */
const AA_BAR = 4.5

/**
 * The one role allowed to sit under `HOUSE_BAR`, named rather than derived.
 *
 * Named so the exception cannot spread. A test that said "the dimmest entry"
 * or "whichever one fails" would quietly admit a second role the day someone
 * lowered one, which is the whole failure mode this file exists to catch.
 */
const DIM_ROLE = 'comment'

/** What ordinary text in an editor pane is drawn in. See `FileView.tsx`. */
const PLAIN_TEXT = '#d4d4d8'

/**
 * How far `comment` must stay from plain text to still read as a comment.
 *
 * Contrast ratio, and not a hue distance, because the two are both neutral
 * greys: they differ in lightness alone, and being quieter IS a lightness
 * relationship. 1.5 is a chosen threshold and not a standard, since WCAG has
 * nothing to say about two foregrounds. It is picked to sit clear of both
 * measured ends: the shipped `#a1a1aa` is 1.73 and the `#d5d5d9` that a
 * 7.89 bar would force is 1.01.
 */
const DIM_SEPARATION = 1.5

const worst = (color: string): number => Math.min(...PANE_COLORS.map((p) => contrast(color, p)))

describe('the syntax palette', () => {
  /**
   * Every colour against every pane, rather than against the default one: the
   * pane's right-click menu lets the user pick any of the six, so a palette
   * measured only against `#09090b` is measured against the easiest case. The
   * lightest, `#38383d`, is where this fails first.
   *
   * **Mutation measured 2026-08-05**: `keyword` put back to `#c4b5fd`, the
   * value it held while the whole palette was on the 4.5 bar, which is exactly
   * the edit a revert or a bad merge would make. FAILED with
   *
   *     keyword #c4b5fd on #2c2c30: expected 7.532923406559516 to be greater
   *     than or equal to 7.89
   *
   * Note WHICH pane it named: `#2c2c30`, the fifth of six, and neither the
   * default nor the lightest. `#c4b5fd` clears 7.89 on the four darkest panes
   * and misses it on the two lightest, so the loop reports the first pane it
   * actually fails on. An earlier mutation in this file failed on `#09090b`
   * and I generalised that into "a failing colour fails on all six"; this run
   * disproves it. Which pane a message names depends on where the colour sits,
   * so the message identifies where to look and never how bad it is. Reverted
   * after measuring.
   */
  it('holds every colour but the dim one to the house 7.89', () => {
    for (const [role, color] of Object.entries(SYNTAX_COLORS)) {
      if (role === DIM_ROLE) continue
      for (const pane of PANE_COLORS) {
        expect(contrast(color, pane), `${role} ${color} on ${pane}`).toBeGreaterThanOrEqual(
          HOUSE_BAR,
        )
      }
    }
  })

  // The exception itself, held to AA and no lower. Separate from the loop
  // above so that loop can skip it by name rather than by a threshold that
  // would also let a second role through.
  it('holds the dim one to AA', () => {
    const color = SYNTAX_COLORS[DIM_ROLE]
    for (const pane of PANE_COLORS) {
      expect(contrast(color, pane), `${DIM_ROLE} ${color} on ${pane}`).toBeGreaterThanOrEqual(
        AA_BAR,
      )
    }
  })

  /**
   * The reason the exception exists, asserted rather than only written down.
   *
   * `comment` is allowed under the house bar because at 7.89 it lands on
   * `#d5d5d9`, 1.01:1 from plain text, and stops reading as quieter than the
   * code. That argument is only worth anything while the colour it defends is
   * actually still quieter, so this checks the premise rather than trusting
   * the docstring.
   *
   * **Mutation measured 2026-08-05**: `comment` set to `#d5d5d9`, the value
   * the house bar would force, which is the exact edit someone "fixing" the
   * exception would make. FAILED with
   *
   *     comment #d5d5d9 against plain text #d4d4d8: expected
   *     1.009888591258392 to be greater than or equal to 1.5
   *
   * **and the AA test above PASSED in that same run**, which is the whole
   * point: raising the colour satisfies every contrast-against-the-background
   * bar in this file and still destroys the one thing the colour is for. Only
   * this assertion sees it. The ranking test below also failed, `expected
   * 'name' to be 'comment'`, because the dimmest entry had stopped being the
   * dim one. Reverted after measuring.
   */
  it('keeps the dim one distinguishable from plain text', () => {
    const color = SYNTAX_COLORS[DIM_ROLE]
    expect(
      contrast(color, PLAIN_TEXT),
      `${DIM_ROLE} ${color} against plain text ${PLAIN_TEXT}`,
    ).toBeGreaterThanOrEqual(DIM_SEPARATION)
  })

  /**
   * The line numbers, held to AA for `comment`'s reason and named the way
   * `comment` is.
   *
   * A second exception, deliberately, and it is stated here rather than folded
   * into the loop above so it stays as unspreadable as the first: `GUTTER_TEXT`
   * is not a syntax role and is not in `SYNTAX_COLORS`, and every test in this
   * file iterates that object. That blind spot is how the gutter shipped at
   * 1.116:1 on the lightest pane while nine syntax colours were held to 7.89.
   *
   * **Mutation measured 2026-08-05**: `GUTTER_TEXT` put back to `#3f3f46`, the
   * `text-faint` it was drawn in, which is exactly the edit a revert would
   * make. FAILED with
   *
   *     line numbers #3f3f46 on #09090b: expected 1.9050225039374264 to be
   *     greater than or equal to 4.5
   *
   * and the quieter-than-plain-text test below PASSED in the same run, which
   * is the pair working as intended: #3f3f46 is quiet, and that was never the
   * problem with it. Reverted after measuring.
   */
  it('holds the line numbers to AA on every pane', () => {
    for (const pane of PANE_COLORS) {
      expect(
        contrast(GUTTER_TEXT, pane),
        `line numbers ${GUTTER_TEXT} on ${pane}`,
      ).toBeGreaterThanOrEqual(AA_BAR)
    }
  })

  // The other half of the exception, again as `comment` has it: a line number
  // that reads as loudly as the code beside it is noise in the margin, so the
  // colour has to stay measurably quieter than plain text as well as legible.
  it('keeps the line numbers quieter than plain text', () => {
    expect(
      contrast(GUTTER_TEXT, PLAIN_TEXT),
      `line numbers ${GUTTER_TEXT} against plain text ${PLAIN_TEXT}`,
    ).toBeGreaterThanOrEqual(DIM_SEPARATION)
  })

  // The bar is a floor and not a target, so this records where the palette
  // actually sits: if a later edit drags everything down to scrape its bar,
  // the tests above still pass and this one says the headroom went. The dim
  // role is the intended floor, being the one entry meant to be quiet.
  it('leaves the dim entry closest to the bar, and nothing below it', () => {
    const ranked = Object.entries(SYNTAX_COLORS).sort((a, b) => worst(a[1]) - worst(b[1]))
    expect(ranked[0][0]).toBe(DIM_ROLE)
    expect(worst(SYNTAX_COLORS[DIM_ROLE])).toBeCloseTo(4.55, 2)
  })

  // Legible and still indistinguishable is a real failure mode: nine pastels
  // that each clear a bar can converge into one pale wash. Contrast between
  // the colours THEMSELVES is the wrong measure for that (two very different
  // hues at the same lightness are near 1:1 against each other), so this asks
  // the cheap structural question and the running app answers the rest.
  it('offers nine distinct colours, not one repeated', () => {
    const values = Object.values(SYNTAX_COLORS)
    expect(new Set(values).size).toBe(values.length)
    expect(values.length).toBe(9)
  })

  it('are all six-digit lowercase hex, the way PANE_COLORS are', () => {
    for (const [role, color] of Object.entries({ ...SYNTAX_COLORS, gutter: GUTTER_TEXT })) {
      expect(color, role).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})
