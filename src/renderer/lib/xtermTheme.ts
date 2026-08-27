import { THEMES, type ThemeId } from '../../shared/themes'

/**
 * The colours xterm is handed for a pane.
 *
 * xterm renders to a canvas and cannot read the custom properties the rest of
 * the app is painted from, so these two values are the one place the palette
 * has to be duplicated out of CSS. Keeping that duplication in a single tested
 * function is what stops it drifting the way the hardcoded `#d4d4d8` it
 * replaces could: that literal sat in `Terminal.tsx` beside a comment asking
 * whoever changed `--color-term-fg` to remember to change it here too.
 *
 * In `lib/` rather than in `Terminal.tsx` because `Terminal.tsx` assigns to
 * `window` at module scope, so importing it under `vitest.config.ts`'s node
 * environment throws before a single assertion runs. The pure helpers in this
 * directory exist for exactly that reason.
 *
 * `paneColor` undefined means the pane has no colour of its own. That is
 * stored as an absent field rather than as the canvas hex, and the absence has
 * to survive all the way here: a caller that resolves it to a default first
 * leaves every uncoloured pane painting one theme's canvas under all six.
 */
export function xtermTheme(
  id: ThemeId,
  paneColor: string | undefined,
): { background: string; foreground: string } {
  const { tokens } = THEMES[id]
  // Pane colours are deliberately all dark (see `paneColors.ts`). A light
  // theme can use a dark foreground on its own white canvas, but that same
  // foreground would become unreadable the moment a user selects one of those
  // dark panes. The explicit pane colour therefore keeps the established pale
  // terminal ink, while an uncoloured pane follows its theme end to end.
  return { background: paneColor ?? tokens.bg, foreground: paneColor ? '#d4d4d8' : tokens.termFg }
}
