/**
 * The tabs column end to end: opening it takes the horizontal bar away,
 * closing it (either through the menu or by collapsing to its strip) brings
 * the bar back, a split nests under its tab instead of drawing as a second
 * tab, and clicking a nested row moves the keyboard to that pane.
 *
 * Modeled on `webgl.spec.ts`'s setup: a temp-dir `beforeEach`/`afterEach`, a
 * seeded single-project config, and a private socket so this file's tmux
 * sessions never touch another spec's or the developer's own.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames, terminalTexts } from './harness'

const SOCKET = 'pterm-e2e-vtabs'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let app: ElectronApplication
let window: Page

/** Fire a menu item by id, the way a click on the real menu bar would. */
async function clickMenuItem(id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click()
  }, id)
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-vtabs-ud-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-vtabs-cfg-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-vtabs-proj-'))
  projectCwd = await mkdtemp(join(tmpdir(), 'pterm-vtabs-cwd-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-vtabs-cs-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, '{}', 'utf8')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-vtabs-home-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [
        { id: 'id-v', name: 'V', slug: 'v', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      activeProjectId: 'id-v',
      tabs: [],
    }),
    'utf8',
  )
  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  window = await app.firstWindow()
  await expect(window.getByTestId('titlebar')).toBeVisible()
})

test.afterEach(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('opening the column takes the horizontal bar away, and closing it brings it back', async () => {
  // Bar first, column hidden: the default every other spec in this suite runs under.
  await expect(window.getByTestId('tabbar')).toBeVisible()
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabs-panel')).toBeVisible()
  await expect(window.getByTestId('tabbar')).toHaveCount(0)
  // The guarantee that matters: no state leaves the workspace without a tab
  // surface. Collapsing to the strip is the other way back, covered below.
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabbar')).toBeVisible()
})

test('collapsing the column to its strip also brings the bar back', async () => {
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabbar')).toHaveCount(0)
  await window.getByTestId('tabs-heading').click()
  await expect(window.getByTestId('tabs-toggle')).toBeVisible()
  await expect(window.getByTestId('tabbar')).toBeVisible()
})

test('a split shows as a child row under its tab', async () => {
  // The bar, not the column, holds `new-tab`: the column has nowhere to put
  // it, so the first pane is opened before the column replaces the bar.
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabs-panel')).toBeVisible()
  const first = (await window.locator('[data-testid^="vtab-"]').getAttribute('data-testid'))!.slice(
    'vtab-'.length,
  )
  await window.keyboard.press('Meta+d')
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  // One tab row and one child row, NOT two tab rows: that is the whole point of
  // the column over the bar, which can only draw the two side by side.
  await expect(window.locator('[data-testid^="vtab-"]')).toHaveCount(1)
  await expect(window.locator('[data-testid^="vpane-"]')).toHaveCount(1)
  // And the tab row is still the pane that was there before the split, not a
  // new node standing in for it.
  await expect(window.getByTestId(`vtab-${first}`)).toBeVisible()
})

test('clicking a child row moves the keyboard to that pane', async () => {
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabs-panel')).toBeVisible()
  const first = (await window.locator('[data-testid^="vtab-"]').getAttribute('data-testid'))!.slice(
    'vtab-'.length,
  )
  await window.keyboard.press('Meta+d')
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  const childId = (await window.locator('[data-testid^="vpane-"]').getAttribute('data-testid'))!.slice(
    'vpane-'.length,
  )
  // A split hands the keyboard straight to the new pane, so the child is
  // already the one selected. Selecting the parent first is what makes the
  // click below a real move rather than a click on what is already active:
  // measured, a click that lands on an already-active row still steals real
  // DOM focus (to the row's own div) without anything putting it back, so
  // this test would pass for the wrong reason without this step.
  await window.getByTestId(`vtab-${first}`).click()
  await window.getByTestId(`vpane-${childId}`).click()
  // Typed text has to land in the pane that was clicked. Read through the
  // buffer helper, because the WebGL renderer leaves `.xterm-rows` empty.
  await window.keyboard.type('echo vtabs-target')
  await expect
    .poll(async () => (await terminalTexts(window)).filter((text) => text.includes('vtabs-target')).length)
    .toBe(1)
})
