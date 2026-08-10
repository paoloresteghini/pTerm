import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { SETTINGS_TABS } from '../../src/renderer/settings/tabs'
import { THEME_IDS } from '../../src/shared/themes'

/**
 * The Appearance tab and the picker it holds, asserted from the source.
 *
 * `vitest.config.ts` runs in the node environment, so there is no DOM to
 * render the picker into and these read the file instead. That is the same
 * approach `labelContrast.test.ts` already takes for the settings sections,
 * and it is worth what it costs here: the things most likely to go wrong
 * silently are the tab's position, the testid prefix, and the picker
 * hardcoding a list of themes that then drifts from the registry.
 */

const SECTION = readFileSync(
  new URL('../../src/renderer/settings/AppearanceSection.tsx', import.meta.url),
  'utf8',
)

describe('the settings tab strip', () => {
  // The full order lives in `settingsTabs.test.ts`, which owns it. This is the
  // one property the picker itself depends on: `SettingsPane` opens on the
  // first entry, which is what makes opening settings land on the picker.
  it('leads with appearance, so the pane opens onto the picker', () => {
    expect(SETTINGS_TABS[0].id).toBe('appearance')
  })

  /**
   * Terminal tabs are counted across the e2e suite by the testid prefix
   * `tab-`. A settings tab is `settings-tab-<id>`, which that selector cannot
   * match, and this is what stops a later rename walking into it.
   */
  it('namespaces its testids away from the terminal tab prefix', () => {
    const strip = readFileSync(
      new URL('../../src/renderer/settings/SettingsTabs.tsx', import.meta.url),
      'utf8',
    )
    expect(strip).toContain('data-testid={`settings-tab-${tab.id}`}')
    for (const tab of SETTINGS_TABS) {
      expect(`settings-tab-${tab.id}`.startsWith('tab-')).toBe(false)
    }
  })
})

describe('the theme picker', () => {
  // A hardcoded list would still render five cards today and silently omit
  // the sixth theme somebody adds later.
  it('offers every theme from the registry rather than a list of its own', () => {
    expect(SECTION).toContain('THEME_IDS')
    for (const id of THEME_IDS) {
      expect(SECTION).not.toContain(`'${id}'`)
    }
  })

  it('gives each card a testid derived from its id', () => {
    expect(SECTION).toContain('data-testid={`theme-${id}`}')
  })

  // The regression `labelContrast.test.ts` exists to catch, checked here too
  // because that file's list is a list of names and this one is new.
  it('does not draw text in the colour that measured 1.86:1 on this ground', () => {
    expect(SECTION).not.toContain('text-faint')
  })

  it('marks the chosen card for assistive technology, not only visually', () => {
    expect(SECTION).toContain('role="radiogroup"')
    expect(SECTION).toContain('aria-checked')
  })

  // Applying on click is the whole design: the app behind the dialog is the
  // preview, so a Save button would put a step between the choice and the
  // thing being chosen.
  it('applies on click rather than behind a save button', () => {
    expect(SECTION).toContain('onClick')
    expect(SECTION).not.toMatch(/>\s*Save\s*</)
  })
})
