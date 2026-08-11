/**
 * The browser region on screen: a column of its own, with a bar of its own.
 *
 * Set up like `tests/e2e/browser.spec.ts`, which this borrows its palette
 * route from: one app per test, its own tmux socket, and a fresh user data
 * directory so no stored column width or collapse flag leaks in from another
 * run. Everything asserted here is host-side chrome. Nothing reads inside a
 * browser pane's guest, which Playwright cannot reach: `page.frames()` reports
 * the guest as `about:blank` and `frameLocator` throws outright (see that
 * file's header for the measurement).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e-browserregion'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir })

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-region-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-region-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-region-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-region-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-region-claude-'))

  projectCwd = join(projectsRoot, 'demo')
  await mkdir(projectCwd, { recursive: true })

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 9,
      // `slug` is required: `isProject` drops a project row without one.
      projects: [
        { id: 'p1', name: 'demo', slug: 'demo', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      panes: [],
      tabs: [],
      activeProjectId: 'p1',
    }),
    'utf8',
  )
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * Opens a browser pane the way a user does, through the palette command.
 *
 * `browser.spec.ts`'s helper of the same shape also returns the new pane's id,
 * read off the last `browsertab-` testid. Nothing here needs the id, and
 * reading it from the browser bar is what the test below is measuring in the
 * first place, so this one returns nothing.
 */
async function openBrowserPaneViaPalette(page: Page): Promise<void> {
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await page.getByTestId('palette-input').fill('New browser pane')
  await page.getByTestId('palette-command-New browser pane').click()
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
}

test('a browser pane opens in its own region, not in the terminal bar', async () => {
  const app = await launch()
  const page = await app.firstWindow()
  await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 20_000 })

  // A real terminal tab first, so the count taken below is a number the
  // browser open could change, rather than a zero it could only leave alone.
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('terminal-active')).toBeVisible()
  const terminalTabsBefore = await page.locator('[data-testid^="tab-"]').count()
  expect(terminalTabsBefore).toBe(1)

  await openBrowserPaneViaPalette(page)

  await expect(page.getByTestId('browser-column')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(1)
  // The assertion that proves the pane LEFT the terminal bar. The two above
  // pass just as well with the pane drawn in both places, and this one is
  // satisfied by the value the count already had, so it is taken after them
  // and never on its own.
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(terminalTabsBefore)
  // The pane itself is inside the column, not merely a column that appeared.
  await expect(
    page.getByTestId('browser-column').locator('[data-testid^="browserpane-"]'),
  ).toHaveCount(1)

  await app.close()
})
