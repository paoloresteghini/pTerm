import { THEMES, THEME_DEFAULT, cssVarName, isThemeId, type ThemeId, type ThemeTokens } from '../shared/themes'

/**
 * Painting the window in one of the five palettes.
 *
 * Set as inline custom properties on `documentElement` rather than by swapping
 * a stylesheet: an inline property beats `@theme`'s `:root` on specificity
 * without needing `!important`, and every Tailwind utility already resolves
 * through `var(--color-*)`, so one assignment repaints everything that
 * references it.
 *
 * `data-theme` is set alongside for anything that needs to branch on the theme
 * in CSS rather than read a token, and so that a screenshot or a devtools
 * inspection says which palette it is looking at.
 */

/** Which properties a theme sets, and to what. Separated so it is testable without a DOM. */
export function themeProperties(id: ThemeId): Record<string, string> {
  const { tokens } = THEMES[id]
  const out: Record<string, string> = {}
  for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
    out[cssVarName(key)] = tokens[key]
  }
  return out
}

export function applyTheme(id: ThemeId): void {
  const root = document.documentElement
  root.dataset.theme = id
  for (const [property, value] of Object.entries(themeProperties(id))) {
    root.style.setProperty(property, value)
  }
}

/**
 * The theme to paint before React mounts.
 *
 * Off the command line rather than over IPC because IPC is a round trip and
 * this has to happen before the first frame. Settings otherwise arrive
 * asynchronously, which would paint the default palette and then swap on every
 * launch, on a window full of terminals.
 */
export function bootTheme(): ThemeId {
  const stored = window.pterm?.env?.theme
  return isThemeId(stored) ? stored : THEME_DEFAULT
}
