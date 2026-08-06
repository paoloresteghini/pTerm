/**
 * The Settings "Updates" section: the running version, and a "Check now"
 * button that answers even when the check fails.
 *
 * A fresh spec file with its own page and its own socket, rather than an
 * addition to `tests/e2e/update.spec.ts`: that file belongs to Task 7 of
 * this plan, which is deferred while another session rewrites `App.tsx`.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'
import { CHANNELS, type MenuCommand } from '../../src/shared/ipc'

const SOCKET = 'prcli-e2e-settingsupdate'

// A typed assignment, not a bare string: if `MenuCommand`'s `settings`
// variant is ever renamed, this line fails to compile rather than the
// `app.evaluate` below silently pushing a command nothing listens for.
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
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-settingsupdate-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-settingsupdate-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-settingsupdate-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-settingsupdate-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-settingsupdate-claude-'))
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
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * The check really runs and really hits the network: nothing stubs the
 * `checkForUpdate` handler's own HTTP call (`PRCLI_UPDATE_CHECK` only gates
 * the background poller in `src/main/update/schedule.ts`, never this
 * button), and the repo it checks against (`paoloresteghini/PRCLI`) does not
 * exist yet. So today the check genuinely 404s and resolves `failed`, which
 * is why the result assertion below is a three-way alternation rather than
 * one string. It is not sloppiness: it is what the button can honestly
 * promise before the check has a real repo, and after one exists the same
 * test still passes on whichever of the three outcomes is true that day.
 */
test('settings names the version and answers a check', async () => {
  await expect(page.getByTestId('titlebar')).toBeVisible()

  // Pinned outside the evaluate below, which is serialised into the main
  // process and cannot import CHANNELS: a renamed channel or command here
  // fails these two expects loudly, instead of the send below silently
  // reaching no listener.
  expect(CHANNELS.menuCommand).toBe('prcli:menuCommand')
  expect(SETTINGS_COMMAND).toBe('settings')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('prcli:menuCommand', 'settings')
  })

  await expect(page.getByTestId('settings-pane')).toBeVisible()
  await expect(page.getByTestId('update-current-version')).toHaveText(/^\d+\.\d+\.\d+$/)

  await page.getByTestId('update-check-now').click()
  await expect(page.getByTestId('update-check-result')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('update-check-result')).toHaveText(
    /is available|up to date|Could not check/,
  )
})
