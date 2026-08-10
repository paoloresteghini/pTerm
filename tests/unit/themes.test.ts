import { describe, it, expect } from 'vitest'
import { contrast, lightnessGap } from './contrast'
import { PANE_COLORS } from '../../src/shared/paneColors'
import { THEMES, THEME_IDS, THEME_DEFAULT, isThemeId, cssVarName } from '../../src/shared/themes'

/**
 * Every palette, held to the rule it declares.
 *
 * Two rules rather than one because the five designs do not all separate their
 * surfaces the same way. Four stack planes and are judged on the distance
 * between them. One deliberately does not, separating by border weight and an
 * inset lip instead, and a single flat-fill rule would have failed a design
 * that works. `separates` is what picks the rule, and it is required, so a
 * sixth theme cannot be added without saying how it is meant to be read.
 */

/** Two fills read as separate planes from here up. Below 1 is not visible at all. */
const FILL_FLOOR = 3.0
/** What a border must clear when it is carrying the separation by itself. */
const EDGE_FLOOR = 20.0
/** WCAG AA for normal text. */
const AA = 4.5
/** What the terminal foreground must clear on any background it can be drawn on. */
const TERM_FLOOR = 7

const themes = THEME_IDS.map((id) => THEMES[id])
const fillThemes = themes.filter((t) => t.separates === 'fill')
const edgeThemes = themes.filter((t) => t.separates === 'edge')

describe('the theme registry', () => {
  it('has an entry for every id, keyed by its own id', () => {
    for (const id of THEME_IDS) expect(THEMES[id].id).toBe(id)
  })

  it('defines every token as a parseable hex in every theme', () => {
    const keys = Object.keys(THEMES[THEME_DEFAULT].tokens)
    for (const theme of themes) {
      expect(Object.keys(theme.tokens).sort()).toEqual(keys.sort())
      for (const [key, value] of Object.entries(theme.tokens)) {
        expect(value, `${theme.id}.${key}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
      }
    }
  })

  it('declares how each theme separates', () => {
    for (const theme of themes) {
      expect(['fill', 'edge', 'baseline']).toContain(theme.separates)
    }
  })

  it('recognises its own ids and nothing else', () => {
    for (const id of THEME_IDS) expect(isThemeId(id)).toBe(true)
    for (const value of ['purple', '', 'CLASSIC', null, 7, undefined]) {
      expect(isThemeId(value)).toBe(false)
    }
  })

  it('maps token keys to the custom property names index.css declares', () => {
    expect(cssVarName('bg')).toBe('--color-bg')
    expect(cssVarName('borderStrong')).toBe('--color-border-strong')
    expect(cssVarName('termFg')).toBe('--color-term-fg')
  })
})

describe('a theme that separates by fill', () => {
  it('clears the fill floor at every step of its ladder', () => {
    for (const { id, tokens } of fillThemes) {
      expect(lightnessGap(tokens.surface, tokens.bg), `${id} surface/bg`).toBeGreaterThanOrEqual(FILL_FLOOR)
      expect(lightnessGap(tokens.raised, tokens.surface), `${id} raised/surface`).toBeGreaterThanOrEqual(FILL_FLOOR)
      expect(lightnessGap(tokens.overlay, tokens.raised), `${id} overlay/raised`).toBeGreaterThanOrEqual(FILL_FLOOR)
    }
  })
})

describe('a theme that separates by edge', () => {
  it('clears the edge floor against its own surface', () => {
    for (const { id, tokens } of edgeThemes) {
      expect(lightnessGap(tokens.border, tokens.surface), `${id} border/surface`).toBeGreaterThanOrEqual(EDGE_FLOOR)
    }
  })

  // Without the lip it is a border and a scrim doing the whole job, which is
  // the version that was rejected. If this token ever goes back to fully
  // transparent, the design it belongs to has quietly become something else.
  it('sets an inset lip rather than leaving it fully transparent', () => {
    for (const { id, tokens } of edgeThemes) {
      expect(tokens.inset, `${id} inset`).not.toMatch(/00$/)
    }
  })
})

describe('the baseline theme', () => {
  const classic = THEMES.classic

  // The recorded defect, asserted so nobody "fixes" it into a fourth stepped
  // theme. Classic is what ships today and changing it is a different decision
  // from adding themes.
  it('is flat, which is the thing the other themes exist to answer', () => {
    expect(classic.separates).toBe('baseline')
    expect(lightnessGap(classic.tokens.surface, classic.tokens.bg)).toBeLessThan(1)
  })

  it('aliases the new tokens onto the surfaces they replace', () => {
    expect(classic.tokens.raised).toBe(classic.tokens.surface)
    expect(classic.tokens.overlay).toBe(classic.tokens.surface)
    expect(classic.tokens.borderStrong).toBe(classic.tokens.border)
    expect(classic.tokens.inset).toMatch(/00$/)
  })
})

describe('text in every theme', () => {
  it('clears AA for the label colour on both grounds it is drawn on', () => {
    for (const { id, tokens } of themes) {
      expect(contrast(tokens.label, tokens.surface), `${id} label/surface`).toBeGreaterThanOrEqual(AA)
      expect(contrast(tokens.label, tokens.bg), `${id} label/bg`).toBeGreaterThanOrEqual(AA)
    }
  })

  it('clears AA for foreground and semantic colours on every fill', () => {
    for (const { id, tokens } of themes) {
      for (const ground of [tokens.bg, tokens.surface, tokens.raised, tokens.overlay]) {
        expect(contrast(tokens.fg, ground), `${id} fg/${ground}`).toBeGreaterThanOrEqual(AA)
        expect(contrast(tokens.ok, ground), `${id} ok/${ground}`).toBeGreaterThanOrEqual(AA)
        expect(contrast(tokens.danger, ground), `${id} danger/${ground}`).toBeGreaterThanOrEqual(AA)
      }
    }
  })

  /**
   * The medium-priority dot in the Todos column, and the first token added
   * for a graphical mark rather than for text. Held to the text floor anyway:
   * it will be a 6px dot per `PRIORITY_DOT`'s classes, where anything looser
   * is guesswork on a real screen.
   */
  it('clears AA for the warn colour on every fill', () => {
    for (const { id, tokens } of themes) {
      for (const ground of [tokens.bg, tokens.surface, tokens.raised, tokens.overlay]) {
        expect(contrast(tokens.warn, ground), `${id} warn/${ground}`).toBeGreaterThanOrEqual(AA)
      }
    }
  })

  /**
   * `muted` is the one floor Classic does not clear: #71717a on #0c0c0e is
   * 4.04:1, and it ships that way today.
   *
   * `FileTree.tsx` accepted that figure on the grounds that "this background is
   * fixed chrome the user cannot recolour". A theme picker is exactly what
   * falsifies that premise, so the floor is demanded of every theme this
   * feature adds. Classic keeps its value because leaving today's palette
   * untouched is the point of it, and its exemption is pinned to the measured
   * number so it cannot quietly get worse.
   */
  it('clears AA for muted in every theme this feature adds', () => {
    for (const { id, tokens } of themes) {
      if (id === 'classic') continue
      for (const ground of [tokens.bg, tokens.surface, tokens.raised, tokens.overlay]) {
        expect(contrast(tokens.muted, ground), `${id} muted/${ground}`).toBeGreaterThanOrEqual(AA)
      }
    }
  })

  it('holds Classic muted at the value it shipped with', () => {
    const { muted, surface } = THEMES.classic.tokens
    expect(contrast(muted, surface)).toBeGreaterThanOrEqual(4.0)
    expect(contrast(muted, surface)).toBeLessThan(AA)
  })
})

describe('the terminal foreground', () => {
  it('clears AAA on its own canvas and on every pane colour', () => {
    for (const { id, tokens } of themes) {
      expect(contrast(tokens.termFg, tokens.bg), `${id} termFg/canvas`).toBeGreaterThanOrEqual(TERM_FLOOR)
      for (const pane of PANE_COLORS) {
        expect(contrast(tokens.termFg, pane), `${id} termFg/${pane}`).toBeGreaterThanOrEqual(TERM_FLOOR)
      }
    }
  })
})

describe('the tab-group strip colour', () => {
  /** The accent at 55% over the theme's own canvas, per `index.css`. */
  function blend(fg: string, bg: string, alpha: number): string {
    const channel = (at: number): string => {
      const mixed = alpha * parseInt(fg.slice(at, at + 2), 16) + (1 - alpha) * parseInt(bg.slice(at, at + 2), 16)
      return Math.round(mixed).toString(16).padStart(2, '0')
    }
    return `#${channel(1)}${channel(3)}${channel(5)}`
  }

  // Computed rather than picked, which is what `index.css` already says about
  // the shipped value. Carrying one theme's blend into another leaves the strip
  // off-relation to the ground under it, and by eye that is invisible.
  it('is the accent blended over each theme own canvas', () => {
    for (const { id, tokens } of themes) {
      expect(tokens.group, `${id} group`).toBe(blend(tokens.accent, tokens.bg, 0.55))
    }
  })
})
