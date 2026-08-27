import { describe, it, expect } from 'vitest'
import { THEMES } from '../../src/shared/themes'
import { xtermTheme } from '../../src/renderer/lib/xtermTheme'

/**
 * What xterm is handed, computed as a pure function so it can be tested
 * without mounting a terminal.
 *
 * The distinction that matters is between a pane with a colour of its own and
 * a pane without one. An uncoloured pane follows the theme's canvas, which is
 * what makes switching to a theme with a different canvas repaint every
 * default pane. A coloured pane keeps its colour, because the user set it.
 *
 * That distinction only survives if the caller passes the stored value
 * undefined-able. `App.tsx` used to collapse it with `?? PANE_COLOR_DEFAULT`
 * at the call site, which would have left every default pane painting
 * `#09090b` under a theme whose canvas is something else.
 */

describe('the theme xterm is constructed with', () => {
  it('takes the theme own canvas when the pane has no colour', () => {
    expect(xtermTheme('lifted', undefined).background).toBe(THEMES.lifted.tokens.bg)
    expect(xtermTheme('classic', undefined).background).toBe(THEMES.classic.tokens.bg)
  })

  // The canvas differs between these two, so a fallback that ignored the theme
  // would still satisfy the `classic` case above on its own.
  it('follows the theme rather than a constant when the pane has no colour', () => {
    expect(xtermTheme('lifted', undefined).background).not.toBe(
      xtermTheme('classic', undefined).background,
    )
  })

  it('keeps a pane own colour, whatever the theme', () => {
    expect(xtermTheme('lifted', '#232326').background).toBe('#232326')
    expect(xtermTheme('slate', '#232326').background).toBe('#232326')
  })

  it('keeps pale terminal ink on an explicitly dark pane in the light theme', () => {
    expect(xtermTheme('workspaceLight', '#232326')).toEqual({
      background: '#232326',
      foreground: '#d4d4d8',
    })
  })

  it('takes the foreground from the theme rather than a constant', () => {
    expect(xtermTheme('slate', undefined).foreground).toBe(THEMES.slate.tokens.termFg)
    expect(xtermTheme('classic', undefined).foreground).toBe('#d4d4d8')
  })

  // Slate is the one theme that moves the foreground. If these ever match, the
  // foreground has stopped being read per theme and the assertion above is
  // passing on a coincidence.
  it('gives different themes different foregrounds', () => {
    expect(xtermTheme('slate', undefined).foreground).not.toBe(
      xtermTheme('classic', undefined).foreground,
    )
  })

  // A pane explicitly set to the colour that happens to be Classic's canvas is
  // not the same as a pane with no colour, and must not start following the
  // theme because the two values coincide in one palette.
  it('keeps an explicit colour that matches one theme canvas', () => {
    expect(xtermTheme('lifted', '#09090b').background).toBe('#09090b')
  })
})
