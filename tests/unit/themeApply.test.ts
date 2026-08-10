import { describe, it, expect } from 'vitest'
import { THEMES, cssVarName, type ThemeTokens } from '../../src/shared/themes'
import { themeProperties } from '../../src/renderer/theme'

/**
 * The token-to-property mapping, tested without a DOM.
 *
 * `vitest.config.ts` runs in the node environment, so `applyTheme` itself
 * cannot be called here. The part worth testing is which properties it would
 * set to which values, so that computation is a separate exported function and
 * `applyTheme` is the two lines that hand it to `documentElement`.
 */

describe('the properties a theme sets', () => {
  it('covers every token', () => {
    const props = themeProperties('stepped')
    const keys = Object.keys(THEMES.stepped.tokens) as (keyof ThemeTokens)[]
    expect(Object.keys(props)).toHaveLength(keys.length)
    for (const key of keys) {
      expect(props[cssVarName(key)]).toBe(THEMES.stepped.tokens[key])
    }
  })

  it('uses the custom property names index.css declares', () => {
    const props = themeProperties('lifted')
    expect(props['--color-bg']).toBe('#060607')
    expect(props['--color-border-strong']).toBe('#45454e')
    expect(props['--color-term-fg']).toBe('#d4d4d8')
  })

  it('gives the edge-separating theme a visible lip', () => {
    expect(themeProperties('lineled')['--color-inset']).toBe('#ffffff0e')
  })
})
