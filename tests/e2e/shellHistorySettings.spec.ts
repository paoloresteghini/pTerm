/**
 * The Settings "Shell history" row: what it shows before install, and that
 * Install then Uninstall leaves the rc file exactly as it started.
 *
 * A fresh spec file with its own page and its own socket, following
 * `settingsUpdate.spec.ts`'s lead. `PTERM_ZSHRC` is pointed at a temp file
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

const SOCKET = 'pterm-e2e-shellhistorysettings'

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
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-shellhistorysettings-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-shellhistorysettings-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-shellhistorysettings-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-shellhistorysettings-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-shellhistorysettings-claude-'))
  zshrcDir = await mkdtemp(join(tmpdir(), 'pterm-shellhistorysettings-zshrc-'))
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
    BrowserWindow.getAllWindows()[0].webContents.send('pterm:menuCommand', 'settings')
  })
  expect(SETTINGS_COMMAND).toBe('settings')

  await expect(page.getByTestId('settings-pane')).toBeVisible()
  await expect(page.getByTestId('shell-history-status')).toHaveText('not installed')

  // Names the file it will edit and the script it will write, not just some
  // fixed row of copy: the rc path here is the temp file this spec made, and
  // nothing else in the suite could have produced that exact string.
  const pathsText = await page.getByTestId('shell-history-paths').innerText()
  expect(pathsText).toContain(zshrcPath)
  expect(pathsText).toContain('pterm-history.zsh')
  const scriptPath = pathsText.match(/sources (\S+pterm-history\.zsh)\.$/)?.[1]
  if (!scriptPath) throw new Error(`could not extract scriptPath from "${pathsText}"`)

  /*
   * The consent copy, and the reason it is asserted here rather than left to a
   * reader of the component.
   *
   * Installing starts a permanent record of every command typed in a shell
   * pane. Everything else on this row describes edits to two files the user
   * asked for; none of it says that. This is the only screen in the app that
   * mentions the feature, and the pending block below it shows only the
   * `source` line, so a user reading the exact text on offer still would not
   * find out. Four separate facts are checked because dropping any one of them
   * leaves the row misleading rather than merely terse: where the record is
   * kept, how to keep one command out of it, that uninstalling does not reach
   * a pane that is already open, and that it is not deletion.
   *
   * The third of those is the one with teeth. Uninstall rewrites `.zshrc` and
   * touches nothing else, so a running pane keeps recording; a user who
   * uninstalls to stop a secret being logged and then keeps typing in the pane
   * they already had open gets it logged, having just read this screen. Copy
   * that said "Uninstalling stops the recording" shipped here and was wrong.
   *
   * The path is the sharp end for a different reason. It is this spec's own
   * temp config directory, so no fixed string typed into the component could
   * satisfy it.
   */
  const disclosure = await page.getByTestId('shell-history-disclosure').innerText()
  expect(disclosure).toContain(join(configDir, 'history.jsonl'))
  expect(disclosure).toContain('leading space')
  expect(disclosure).toContain('keeps recording until you close and reopen it')
  expect(disclosure).toContain('nothing in this app deletes it')

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
