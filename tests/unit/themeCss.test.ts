import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { THEMES, THEME_DEFAULT, cssVarName, type ThemeTokens } from '../../src/shared/themes'

/**
 * The one duplication this design accepts, guarded.
 *
 * Tailwind v4 needs every token declared in `@theme` at build time or the
 * utility that references it is never emitted, so `index.css` has to carry a
 * literal value for each. The runtime values come from the registry, which
 * means Classic's palette exists in two files. This test is what stops them
 * drifting: a hex changed in one place and not the other would leave the app
 * painting one palette before `applyTheme` runs and another after.
 */

const CSS = readFileSync(new URL('../../src/renderer/index.css', import.meta.url), 'utf8')

/** Reads a `--color-x: #rrggbb;` or `#rrggbbaa` declaration out of the file. */
function declared(property: string): string | null {
  const found = new RegExp(`${property}:\\s*(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)\\s*;`).exec(CSS)
  return found ? found[1].toLowerCase() : null
}

describe('index.css and the theme registry', () => {
  const tokens = THEMES[THEME_DEFAULT].tokens

  it('declares every token the registry defines', () => {
    for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
      expect(declared(cssVarName(key)), `${cssVarName(key)} missing from index.css`).not.toBeNull()
    }
  })

  it('declares them with the default theme own values', () => {
    for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
      expect(declared(cssVarName(key)), cssVarName(key)).toBe(tokens[key].toLowerCase())
    }
  })

  // The lip is the edge-separating theme whole mechanism. A rule that reads
  // any other property would leave that theme with nothing but a border.
  it('draws the inset lip from the token', () => {
    expect(CSS).toMatch(/\.lip\s*\{[^}]*box-shadow:\s*inset 0 1px 0 var\(--color-inset\)/)
  })
})
