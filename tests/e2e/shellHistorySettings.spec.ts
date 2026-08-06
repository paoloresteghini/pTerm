/**
 * The Settings "Shell history" row: what it shows before install, and that
 * Install then Uninstall leaves the rc file exactly as it started.
 *
 * A fresh spec file with its own page and its own socket, following
 * `settingsUpdate.spec.ts`'s lead. `PRCLI_ZSHRC` is pointed at a temp file
 * for the whole run: without it this row would read and write the
 * developer's real `~/.zshrc`, which is the one thing `harness.ts` exists to
 * rule out.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'
import { block } from '../../src/main/shell/install'
import { type MenuCommand } from '../../src/shared/ipc'

const SOCKET = 'prcli-e2e-shellhistorysettings'

const SETTINGS_COMMAND: MenuCommand = 'settings'

// What the temp rc file starts with, chosen to look like a real dotfile: a
// line before where the block will land, and no trailing newline, which is
// the branch of `merge`/`unmerge` most likely to lose a byte on the round
// trip if either regressed.
const ORIGINAL_RC = 'export PATH="$PATH:/usr/local/bin"\nalias ll="ls -la"'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let zshrcDir: string
let zshrcPath: string

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-shellhistorysettings-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-shellhistorysettings-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-shellhistorysettings-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-shellhistorysettings-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-shellhistorysettings-claude-'))
  zshrcDir = await mkdtemp(join(tmpdir(), 'prcli-shellhistorysettings-zshrc-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  zshrcPath = join(zshrcDir, '.zshrc')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))
  await writeFile(zshrcPath, ORIGINAL_RC)

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
    zshrc: zshrcPath,
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome, zshrcDir]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('names its rc and script, shows the real pending block, and round-trips the rc file', async () => {
  await expect(page.getByTestId('titlebar')).toBeVisible()

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('prcli:menuCommand', 'settings')
  })
  expect(SETTINGS_COMMAND).toBe('settings')

  await expect(page.getByTestId('settings-pane')).toBeVisible()
  await expect(page.getByTestId('shell-history-status')).toHaveText('not installed')

  // Names the file it will edit and the script it will write, not just some
  // fixed row of copy: the rc path here is the temp file this spec made, and
  // nothing else in the suite could have produced that exact string.
  const pathsText = await page.getByTestId('shell-history-paths').innerText()
  expect(pathsText).toContain(zshrcPath)
  expect(pathsText).toContain('prcli-history.zsh')
  const scriptPath = pathsText.match(/sources (\S+prcli-history\.zsh)\.$/)?.[1]
  if (!scriptPath) throw new Error(`could not extract scriptPath from "${pathsText}"`)

  // The pending block shown on screen is what `block()` actually produces
  // for that script path, not a lookalike string typed into the component.
  await expect(page.getByTestId('shell-history-pending')).toHaveText(block(scriptPath))

  await page.getByTestId('shell-history-install').click()
  await expect(page.getByTestId('shell-history-status')).toHaveText('installed')
  await expect(page.getByTestId('shell-history-install')).toBeDisabled()
  await expect(page.getByTestId('shell-history-uninstall')).toBeEnabled()

  const afterInstall = await readFile(zshrcPath, 'utf8')
  expect(afterInstall).not.toBe(ORIGINAL_RC)
  expect(afterInstall).toContain(block(scriptPath))

  await page.getByTestId('shell-history-uninstall').click()
  await expect(page.getByTestId('shell-history-status')).toHaveText('not installed')
  await expect(page.getByTestId('shell-history-uninstall')).toBeDisabled()
  await expect(page.getByTestId('shell-history-install')).toBeEnabled()

  // Byte-for-byte: install then uninstall must leave nothing behind, not
  // even a stray blank line.
  const afterUninstall = await readFile(zshrcPath, 'utf8')
  expect(afterUninstall).toBe(ORIGINAL_RC)
})
