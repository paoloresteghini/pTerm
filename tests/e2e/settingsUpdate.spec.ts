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

const SOCKET = 'pterm-e2e-settingsupdate'

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
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-settingsupdate-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-settingsupdate-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-settingsupdate-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-settingsupdate-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-settingsupdate-claude-'))
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
 * `checkForUpdate` handler's own HTTP call (`PTERM_UPDATE_CHECK` only gates
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
  expect(CHANNELS.menuCommand).toBe('pterm:menuCommand')
  expect(SETTINGS_COMMAND).toBe('settings')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pterm:menuCommand', 'settings')
  })

  await expect(page.getByTestId('settings-pane')).toBeVisible()
  await expect(page.getByTestId('update-current-version')).toHaveText(/^\d+\.\d+\.\d+$/)

  // Everything below is behind the Updates tab; the version above is not,
  // which is the point of the footer.
  await page.getByTestId('settings-tab-updates').click()
  await page.getByTestId('update-check-now').click()
  await expect(page.getByTestId('update-check-result')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('update-check-result')).toHaveText(
    /is available|up to date|Could not check/,
  )

  // The Download button exists only when the check actually found a release
  // to open. Which branch that is depends on the real network response and
  // the version this source tree carries, so this asserts the conditional
  // rather than a fixed outcome: present exactly when the result text says
  // one is available, absent otherwise.
  const resultText = await page.getByTestId('update-check-result').innerText()
  const expectedCount = /is available/.test(resultText) ? 1 : 0
  await expect(page.getByTestId('update-download-settings')).toHaveCount(expectedCount)

  // Skip renders under the same condition as Download, for the same reason:
  // nothing to skip without a named release.
  await expect(page.getByTestId('update-skip-settings')).toHaveCount(expectedCount)
})

test('appearance keeps editor and terminal font choices independent', async () => {
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pterm:menuCommand', 'settings')
  })
  await expect(page.getByTestId('settings-pane')).toBeVisible()
  await page.getByTestId('settings-tab-appearance').click()

  await page.getByTestId('editor-font').selectOption('jetbrains')
  await page.getByTestId('terminal-font').selectOption('fira')

  await expect(page.getByTestId('editor-font')).toHaveValue('jetbrains')
  await expect(page.getByTestId('terminal-font')).toHaveValue('fira')
  await expect
    .poll(() =>
      page.evaluate(() => ({
        editor: localStorage.getItem('pterm:editorFont'),
        terminal: localStorage.getItem('pterm:terminalFont'),
      })),
    )
    .toEqual({ editor: 'jetbrains', terminal: 'fira' })
})
