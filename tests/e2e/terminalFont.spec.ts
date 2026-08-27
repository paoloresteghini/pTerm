/**
 * The bundled symbol face, and whether it is the thing making the terminal's
 * symbols fit their cell.
 *
 * xterm draws every cell at one fixed width, so a glyph whose advance is not
 * that width is clipped. Claude Code prints U+23F5 for auto mode and cycles
 * braille for its spinner, and no monospace font on macOS covers U+23F5 at
 * all, so both used to fall to a face whose advance does not fit.
 * `src/renderer/fonts/pterm-symbols.woff2` is the subset that covers them;
 * `index.css` declares it and `Terminal.tsx` names it in the stack.
 *
 * **Measured in this app's own Electron 43, 2026-08-13.** The cell is 7.827px
 * at the terminal's 13px. Against the stack WITHOUT the bundled family,
 * U+23F5 measured 0.835 of a cell, U+23FA 1.046 and braille 1.135; with it,
 * every one of them measures 0.997. Seven characters that were already fine
 * (`M`, `x`, `█`, `╭`, `❯`, `⚠`, `●`) measured exactly 1.000 both ways, and
 * the cell itself is 7.827px both ways. Appending the family after `Menlo`
 * is what leaves them alone. Those same numbers came out of Playwright's
 * Chromium 1.62 first and were identical, which is the only reason it is
 * worth saying they were re-taken here.
 *
 * The second test is the control, and it is the reason the first one means
 * anything. This machine has the full JuliaMono installed system-wide
 * (`~/Library/Fonts`), and JuliaMono is what the subset is cut from, so a
 * stack that named `JuliaMono` would measure 0.997 here whether or not the
 * bundled file loaded, was packaged, or existed. Naming a private family is
 * what makes the two distinguishable, and the control asserts the bug is
 * still there when that private family is taken out of the stack. It is also
 * why the first test asserts the shipped stack does not name `JuliaMono`: on
 * this machine that substitution would be invisible, and would ship the bug
 * to everyone who has not run `brew install --cask font-juliamono`.
 *
 * The stack is read out of `Terminal.tsx` rather than copied here, so this
 * file cannot drift into measuring a stack the app no longer uses.
 *
 * **What this file does NOT see:**
 *
 * - **the pixels.** Every assertion here is an advance width. That the glyph
 *   drawn into the cell is the right shape was established by looking at
 *   before/after screenshots of a real pane, and nothing here re-checks it.
 * - **the atlas repair.** `Terminal.tsx` clears the texture atlas when the
 *   font resolves, for panes built before it loaded. These tests measure a
 *   canvas of their own, not xterm's atlas, so deleting that repair leaves
 *   this file green. What it would break is the first frame of a cold start,
 *   which is a picture and not a number.
 * - **any renderer distinction.** Nothing here asks whether the pane got
 *   WebGL or DOM; `webgl.spec.ts` owns that.
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'
import { DEFAULT_TERMINAL_FONT, terminalFontFamily } from '../../src/renderer/fonts'

// This file's own tmux server. Nothing here touches the user's default socket.
const SOCKET = 'pterm-e2e-font'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir })

/**
 * The default terminal stack, derived through the same helper `Terminal.tsx`
 * uses to configure xterm.
 */
async function shippedStack(): Promise<string> {
  return terminalFontFamily(DEFAULT_TERMINAL_FONT)
}

/** The advance of each character as a fraction of the advance of `M`. */
async function ratios(
  window: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  stack: string,
): Promise<{ cell: number; of: Record<string, number> }> {
  return window.evaluate((s) => {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.font = `13px ${s}`
    const cell = ctx.measureText('M').width
    const of: Record<string, number> = {}
    // The two ranges the subset covers, plus characters Menlo already fitted.
    for (const ch of ['⏵', '⏴', '⏺', '⠇', '⣿', 'M', 'x', '█', '╭', '❯', '⚠', '●']) {
      of[ch] = Number((ctx.measureText(ch).width / cell).toFixed(3))
    }
    return { cell: Number(cell.toFixed(3)), of }
  }, stack)
}

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-e2e-root-'))
  projectCwd = await mkdtemp(join(tmpdir(), 'pterm-proj-font-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [
        { id: 'id-font', name: 'Font', slug: 'font', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      activeProjectId: 'id-font',
      tabs: [],
    }),
    'utf8',
  )
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-e2e-claude-'))
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the shipped stack fits every symbol to the cell, and leaves the rest alone', async () => {
  const stack = await shippedStack()
  // The private name is the whole reason the control below can fail. A stack
  // naming the upstream family would pass every assertion here on any machine
  // that happens to have it installed, and ship the bug to every machine that
  // does not.
  expect(stack).toContain('pTerm Symbols')
  expect(stack).not.toContain('JuliaMono')

  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal')).toBeVisible()

  // The face has to have actually loaded from the packaged bundle. A missing
  // or unreferenced woff2 leaves this false while every ratio below still
  // reads correctly on a machine with the upstream font installed.
  await expect.poll(() => window.evaluate(() => document.fonts.check("13px 'pTerm Symbols'"))).toBe(true)

  const { cell, of } = await ratios(window, stack)
  expect(cell).toBeCloseTo(7.827, 2)
  // The subset's two ranges: the media controls and braille.
  for (const ch of ['⏵', '⏴', '⏺', '⠇', '⣿']) {
    expect(of[ch], `${ch} must fit the cell`).toBeGreaterThan(0.98)
    expect(of[ch], `${ch} must fit the cell`).toBeLessThan(1.02)
  }
  // What must not have moved. These come from Menlo, ahead of the subset.
  for (const ch of ['M', 'x', '█', '╭', '❯', '⚠', '●']) {
    expect(of[ch], `${ch} must be untouched`).toBe(1)
  }
  await app.close()
})

test('without the bundled family those same symbols do not fit', async () => {
  const withoutBundled = (await shippedStack()).replace("'pTerm Symbols', ", '')
  expect(withoutBundled).not.toContain('pTerm Symbols')

  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal')).toBeVisible()

  const { cell, of } = await ratios(window, withoutBundled)
  // Same cell: the fix is not moving the grid, only what fills it.
  expect(cell).toBeCloseTo(7.827, 2)
  // Asserted as ranges around the measured values rather than as "not 1", so
  // that a change which merely swapped one bad fallback for another is still
  // a failure here and has to be looked at.
  expect(of['⏵']).toBeCloseTo(0.835, 2)
  expect(of['⏴']).toBeCloseTo(0.835, 2)
  expect(of['⏺']).toBeCloseTo(1.046, 2)
  expect(of['⠇']).toBeCloseTo(1.135, 2)
  expect(of['⣿']).toBeCloseTo(1.135, 2)
  // Unchanged even here, which is what makes them the wrong thing to blame.
  for (const ch of ['M', 'x', '█', '╭', '❯', '⚠', '●']) {
    expect(of[ch]).toBe(1)
  }
  await app.close()
})
