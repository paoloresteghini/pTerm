/**
 * The `diff` pane: clicking a changed file in the git column opens its
 * unified diff, read-only, and the pane survives a relaunch.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { launchApp, killServer, expandColumn } from './harness'

const run = promisify(execFile)
const SOCKET = 'pterm-e2e-gitdiff'

let userDataDir: string
let configDir: string
let projectsRoot: string
let repo: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let app: ElectronApplication
let page: Page

/** git, with an identity of its own so no developer config is needed. */
async function gitIn(cwd: string, args: string[]): Promise<void> {
  await run('git', ['-c', 'user.name=pterm', '-c', 'user.email=pterm@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=master', ...args], { cwd })
}

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-e2e-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-e2e-claude-'))

  repo = await mkdtemp(join(tmpdir(), 'pterm-e2e-repo-'))
  await gitIn(repo, ['init'])
  await writeFile(join(repo, 'tracked.txt'), 'one\n', 'utf8')
  await gitIn(repo, ['add', 'tracked.txt'])
  await gitIn(repo, ['commit', '-m', 'first'])

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [{ id: 'id-repo', name: 'Repo', slug: 'repo', cwd: repo, presets: [], activeTabId: null }],
      activeProjectId: 'id-repo',
      tabs: [],
    }),
    'utf8',
  )
})

test.afterEach(async () => {
  await app?.close()
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, repo, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function open(): Promise<void> {
  app = await launchApp({ socket: SOCKET, configDir, projectsRoot,
    claudeSettings: claudeSettingsPath, claudeHome, userDataDir })
  page = await app.firstWindow()
  await expandColumn(page, 'git')
}

test('clicking a changed file opens its diff', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await open()

  await page.getByTestId('gitpanel-unstaged-tracked.txt').click()

  await expect(page.getByTestId('diff-content')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('diff-content')).toContainText('-one')
  await expect(page.getByTestId('diff-content')).toContainText('+two')
})

test('an untracked file shows as wholly added', async () => {
  await writeFile(join(repo, 'fresh.txt'), 'brand new\n', 'utf8')
  await open()

  await page.getByTestId('gitpanel-unstaged-fresh.txt').click()

  await expect(page.getByTestId('diff-content')).toContainText('+brand new', { timeout: 15_000 })
})

// The seam that silently erases a new pane type: sessionlessPanes.ts's filter.
test('a diff pane survives a relaunch', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await open()
  await page.getByTestId('gitpanel-unstaged-tracked.txt').click()
  await expect(page.getByTestId('diff-content')).toBeVisible({ timeout: 15_000 })
  await app.close()

  app = await launchApp({ socket: SOCKET, configDir, projectsRoot,
    claudeSettings: claudeSettingsPath, claudeHome, userDataDir })
  page = await app.firstWindow()
  await expect(page.getByTestId('diff-content')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('diff-content')).toContainText('+two')
})
