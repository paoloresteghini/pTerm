/**
 * The Issues column's registration: hidden by default, reachable from the
 * View menu, and collapsible to a strip like every other column.
 *
 * Registration only: nothing here launches `gh` or asserts a row. What the
 * column draws once open is covered by `issuesList.spec.ts` (list, search,
 * heading, empty states), `issueModal.spec.ts` and `issueMutations.spec.ts`,
 * all of which point `PTERM_GH_BIN` at a stub this file deliberately does not
 * need.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e-issues-column'

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

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-root-'))
  projectCwd = await mkdtemp(join(tmpdir(), 'pterm-proj-issues-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-claude-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [
        { id: 'id-issues', name: 'Issues', slug: 'issues', cwd: projectCwd, presets: [], activeTabId: null },
      ],
      activeProjectId: 'id-issues',
      tabs: [],
    }),
    'utf8',
  )
  app = await launchApp({ socket: SOCKET, configDir, projectsRoot,
    claudeSettings: claudeSettingsPath, claudeHome, userDataDir })
  page = await app.firstWindow()
  // Every column starts hidden, so there is no per-column element to wait on
  // before the first menu click; the title bar is what proves the window has
  // painted at all.
  await expect(page.getByTestId('titlebar')).toBeVisible()
})

test.afterEach(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the issues column is hidden on a fresh profile and the View menu shows it', async () => {
  await expect(page.getByTestId('issues-toggle')).toHaveCount(0)
  await clickMenuItem('toggle-issues')
  await expect(page.getByTestId('issues-toggle')).toHaveCount(1)
})

test('the heading collapses it to a strip and the strip brings it back', async () => {
  await clickMenuItem('toggle-issues')
  await expect(page.getByTestId('issues-panel')).toBeVisible()

  await page.getByTestId('issues-toggle').click()
  await expect(page.getByTestId('issues-panel')).toHaveCount(0)

  await page.getByTestId('issues-toggle').click()
  await expect(page.getByTestId('issues-panel')).toHaveCount(1)
})
