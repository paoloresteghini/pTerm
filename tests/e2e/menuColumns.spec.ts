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

// `isChecked` and `labelOf` (checking a checkbox's state and reading a menu
// item's label) belong here per the brief, but `tsconfig.json` has
// `noUnusedLocals: true`, which rejects them unused. Task 4 adds them back
// alongside the tests that call them.

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
