import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { contrast } from './contrast'

/**
 * The colour the NOTES / SKILLS / PRESETS headings are drawn in, held to a
 * number rather than to a name.
 *
 * This exists because the headings shipped in `--color-faint` on
 * `--color-surface`, which measures 1.86:1, under the 3:1 that WCAG asks of a
 * graphical object, let alone the 4.5:1 for text, and reported by the user as
 * unreadable. A class-name assertion would have been just as green with the
 * old value in it, so the test reads the two hexes out of `index.css` and does
 * the arithmetic. Same approach as `syntaxColors.test.ts`, on a different list.
 */

const CSS = readFileSync(new URL('../../src/renderer/index.css', import.meta.url), 'utf8')

/** WCAG AA for normal text. `--color-label` is text, so this is the floor. */
const AA_BAR = 4.5

/** Reads a `--color-x: #rrggbb;` declaration out of the `@theme` block. */
function token(name: string): string {
  const found = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(CSS)
  if (!found) throw new Error(`no --color-${name} in index.css`)
  return found[1].toLowerCase()
}

describe('the section-label colour', () => {
  it('clears AA against the panel background it is drawn on', () => {
    expect(contrast(token('label'), token('surface'))).toBeGreaterThanOrEqual(AA_BAR)
  })

  // The panels sit on `--color-surface`, but a heading that overhangs onto the
  // window background must not become the failure this test was meant to stop.
  it('clears AA against the window background too', () => {
    expect(contrast(token('label'), token('bg'))).toBeGreaterThanOrEqual(AA_BAR)
  })

  // The regression in its own words: `--color-faint` is what the headings used
  // to be, and it is nowhere near the bar. If a repalette ever brought the two
  // tokens together, the assertions above would still pass while the headings
  // went back to being invisible only if faint were also raised, so this pins
  // the direction rather than the distance.
  it('is lighter than the faint colour it replaced', () => {
    const onSurface = (hex: string): number => contrast(hex, token('surface'))
    expect(onSurface(token('label'))).toBeGreaterThan(onSurface(token('faint')))
  })

  // One home for the colour. Three columns render these headings and each used
  // to spell the class out itself, which is how one of them drifting is a bug
  // nobody notices.
  it('is applied in one place, `ui/Panel.tsx`', () => {
    const panel = readFileSync(new URL('../../src/renderer/ui/Panel.tsx', import.meta.url), 'utf8')
    expect(panel.match(/text-label/g)).toHaveLength(2)
    // `FileTree` rather than `FilesPanel`: the files column's heading sits
    // beside the refresh control, so it is the tree that renders it.
    for (const file of ['NotesPanel', 'SkillsPanel', 'PresetsPanel', 'FileTree']) {
      const source = readFileSync(new URL(`../../src/renderer/${file}.tsx`, import.meta.url), 'utf8')
      expect(source).toContain('PanelHeading')
      expect(source).not.toContain('uppercase tracking-wider')
    }
    // The one heading that is not a `PanelHeading` (its column does not
    // collapse) still has to be drawn in the label colour.
    const sidebar = readFileSync(new URL('../../src/renderer/Sidebar.tsx', import.meta.url), 'utf8')
    expect(sidebar).toContain('uppercase tracking-wider text-label')
    expect(sidebar).not.toContain('uppercase tracking-wider text-faint')
  })

  // The settings pane drew its section headings in `text-faint` on
  // `bg-surface` until 2026-08-07, which is the same 1.86:1 pair this file
  // exists because of. It was missed the first time because that fix went
  // through `ui/Panel.tsx`, which the settings sections do not use.
  it('is what the settings sections draw their headings in', () => {
    const dir = new URL('../../src/renderer/settings/', import.meta.url)
    for (const file of [
      'HooksSection.tsx',
      'ShellHistorySection.tsx',
      'NotificationsSection.tsx',
      'UpdatesSection.tsx',
    ]) {
      const source = readFileSync(new URL(file, dir), 'utf8')
      expect(source).toContain('text-label')
      expect(source).not.toContain('text-faint')
    }
  })
})
