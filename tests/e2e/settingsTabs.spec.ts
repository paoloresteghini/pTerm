/**
 * The settings pane's tab strip: which tab it opens on, that selecting one
 * unmounts the last, that the version footer is on every tab, and that the
 * arrow keys move the selection.
 *
 * The unmount assertions are `toHaveCount(0)`, not `not.toBeVisible()`. That
 * is the whole point of the test: hiding an inactive tab and unmounting it
 * look identical to a visibility assertion, and only unmounting gives each
 * section the fresh read on select that this design relies on.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'
import { CHANNELS, type MenuCommand } from '../../src/shared/ipc'

const SOCKET = 'pterm-e2e-settingstabs'

// A typed assignment, not a bare string: a renamed `settings` variant fails
// to compile here rather than sending a command nothing listens for.
const SETTINGS_COMMAND: MenuCommand = 'settings'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-settingstabs-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-settingstabs-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-settingstabs-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-settingstabs-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-settingstabs-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  const alphaCwd = join(projectsRoot, 'alpha')
  await mkdir(alphaCwd, { recursive: true })

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      projects: [{ id: 'id-alpha', name: 'alpha', slug: 'alpha', cwd: alphaCwd, presets: [] }],
      tabs: [],
      activeProjectId: 'id-alpha',
      activeTabId: null,
    }),
  )

  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

const openSettings = async (): Promise<void> => {
  expect(CHANNELS.menuCommand).toBe('pterm:menuCommand')
  expect(SETTINGS_COMMAND).toBe('settings')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pterm:menuCommand', 'settings')
  })
  await expect(page.getByTestId('settings-pane')).toBeVisible()
}

test('opens on Notifications and mounts only that section', async () => {
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await openSettings()

  await expect(page.getByTestId('settings-tab-notifications')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('mute-when-focused')).toBeVisible()

  // The other three sections are not in the DOM at all.
  await expect(page.getByTestId('hooks-status')).toHaveCount(0)
  await expect(page.getByTestId('shell-history-status')).toHaveCount(0)
  await expect(page.getByTestId('update-check-now')).toHaveCount(0)
})

test('selecting a tab mounts its section and unmounts the last', async () => {
  await page.getByTestId('settings-tab-hooks').click()
  await expect(page.getByTestId('hooks-status')).toBeVisible()
  await expect(page.getByTestId('mute-when-focused')).toHaveCount(0)

  await page.getByTestId('settings-tab-shell-history').click()
  await expect(page.getByTestId('shell-history-status')).toBeVisible()
  await expect(page.getByTestId('hooks-status')).toHaveCount(0)

  await page.getByTestId('settings-tab-updates').click()
  await expect(page.getByTestId('update-check-now')).toBeVisible()
  await expect(page.getByTestId('shell-history-status')).toHaveCount(0)
})

test('the version footer is on every tab', async () => {
  // Still on Updates from the test above. The footer belongs to the shell, so
  // it must survive every selection, including the tab it used to live on.
  await expect(page.getByTestId('update-current-version')).toHaveText(/^\d+\.\d+\.\d+$/)
  for (const id of ['notifications', 'hooks', 'shell-history']) {
    await page.getByTestId(`settings-tab-${id}`).click()
    // Proves the click actually moved the selection, not just that the
    // footer's text (identical on every tab) happened to match again.
    await expect(page.getByTestId(`settings-tab-${id}`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('update-current-version')).toHaveText(/^\d+\.\d+\.\d+$/)
  }
})

test('the arrow keys move the selection', async () => {
  // Land on a known tab first: this file shares one page across its tests, so
  // "wherever the last test left it" is not a starting point.
  await page.getByTestId('settings-tab-notifications').click()
  await expect(page.getByTestId('settings-tab-notifications')).toHaveAttribute('aria-selected', 'true')

  // `locator.press()` focuses its own target before dispatching, so it can
  // only seed the first key: used again on the second and third, it would
  // plant focus itself and prove nothing about where the component actually
  // left it. So only this first press comes from a locator; the rest go
  // through `page.keyboard`, which fires wherever focus already is, and the
  // `toBeFocused` right after it is what confirms the component moved focus
  // there itself (`buttons.current[...].focus()` in SettingsTabs.tsx).
  await page.getByTestId('settings-tab-notifications').press('ArrowRight')
  await expect(page.getByTestId('settings-tab-hooks')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('settings-tab-hooks')).toBeFocused()
  await expect(page.getByTestId('hooks-status')).toBeVisible()

  // Wrapping backwards off the first tab reaches the last.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('settings-tab-updates')).toHaveAttribute('aria-selected', 'true')
})

test('reopening the pane goes back to Notifications', async () => {
  await page.getByTestId('settings-tab-updates').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-pane')).toHaveCount(0)

  await openSettings()
  await expect(page.getByTestId('settings-tab-notifications')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('update-check-now')).toHaveCount(0)
})
