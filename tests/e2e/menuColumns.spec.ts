/**
 * The View menu's column items. Driven through the main process, because
 * Playwright cannot reach the macOS menu bar.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let app: ElectronApplication
let page: Page

/** Fire a menu item by id, the way a click on the real menu bar would. */
async function clickMenuItem(id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click()
  }, id)
}

/** Whether a checkbox menu item is ticked, the way a look at the menu bar would show. */
async function isChecked(id: string): Promise<boolean> {
  return app.evaluate(({ Menu }, itemId) => {
    return Menu.getApplicationMenu()?.getMenuItemById(itemId)?.checked ?? false
  }, id)
}

/** A menu item's current label, for the hide-all item's two readings. */
async function labelOf(id: string): Promise<string | undefined> {
  return app.evaluate(({ Menu }, itemId) => {
    return Menu.getApplicationMenu()?.getMenuItemById(itemId)?.label
  }, id)
}

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-e2e-root-'))
  projectCwd = await mkdtemp(join(tmpdir(), 'pterm-proj-menu-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-e2e-claude-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [
        { id: 'id-menu', name: 'Menu', slug: 'menu', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      activeProjectId: 'id-menu',
      tabs: [],
    }),
    'utf8',
  )
  app = await launchApp({ socket: SOCKET, configDir, projectsRoot,
    claudeSettings: claudeSettingsPath, claudeHome, userDataDir })
  page = await app.firstWindow()
  await expect(page.getByTestId('git-toggle')).toBeVisible()
})

test.afterEach(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a column item opens and closes its column', async () => {
  await expect(page.getByTestId('git-panel')).toHaveCount(0)

  await clickMenuItem('toggle-git')
  await expect(page.getByTestId('git-panel')).toBeVisible()

  await clickMenuItem('toggle-git')
  await expect(page.getByTestId('git-panel')).toHaveCount(0)
})

test('hide all closes every open column, and a second press restores exactly them', async () => {
  await clickMenuItem('toggle-git')
  await clickMenuItem('toggle-notes')
  await expect(page.getByTestId('git-panel')).toBeVisible()
  await expect(page.getByTestId('notes-panel')).toBeVisible()

  await clickMenuItem('hide-all-columns')
  await expect(page.getByTestId('git-panel')).toHaveCount(0)
  await expect(page.getByTestId('notes-panel')).toHaveCount(0)

  await clickMenuItem('hide-all-columns')
  await expect(page.getByTestId('git-panel')).toBeVisible()
  await expect(page.getByTestId('notes-panel')).toBeVisible()
  // Exactly those two, not a default set.
  await expect(page.getByTestId('files-panel')).toHaveCount(0)
  await expect(page.getByTestId('skills-panel')).toHaveCount(0)
})

// Without the sync this fails while the column itself works fine, which is
// exactly the gap Task 3 could not close on its own.
test('opening a column by its strip ticks the menu item', async () => {
  expect(await isChecked('toggle-git')).toBe(false)

  await page.getByTestId('git-toggle').click()
  await expect(page.getByTestId('git-panel')).toBeVisible()

  await expect.poll(() => isChecked('toggle-git'), { timeout: 10_000 }).toBe(true)
})

test('the hide-all item renames itself once everything is hidden', async () => {
  await clickMenuItem('toggle-git')
  await expect.poll(() => labelOf('hide-all-columns'), { timeout: 10_000 }).toBe('Hide All Columns')

  await clickMenuItem('hide-all-columns')
  await expect.poll(() => labelOf('hide-all-columns'), { timeout: 10_000 }).toBe('Show All Columns')
})

// The reason every item sets `registerAccelerator: false`. An
// Electron-registered accelerator fires everywhere, including while the user
// is typing, which this app has shipped as a bug twice.
test('a column shortcut typed into a text field does not toggle the column', async () => {
  await clickMenuItem('toggle-notes')
  await expect(page.getByTestId('notes-panel')).toBeVisible()

  await page.getByTestId('notes-textarea').click()
  await page.keyboard.press('Alt+Meta+G')
  await page.waitForTimeout(500)

  await expect(page.getByTestId('git-panel')).toHaveCount(0)
})
