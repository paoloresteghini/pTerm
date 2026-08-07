/**
 * The status bar along the bottom: the active project's branch, and nothing
 * when that project is not a checkout.
 *
 * A fresh spec file with its own page, so no earlier file's project switching
 * decides which project this file starts on.
 *
 * The repositories here are hand-built `.git` directories rather than real
 * `git init` runs. The app reads `HEAD` and nothing else (src/main/git/branch.ts),
 * so a directory holding that one file is the whole of what it needs, and the
 * tests get to rewrite the branch without shelling out.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer } from './harness'

const SOCKET = 'pterm-e2e-gitbranch'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let repoCwd: string

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-gitbranch-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-gitbranch-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-gitbranch-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-gitbranch-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-gitbranch-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  // One project inside a checkout and one outside it, so "shows the branch" and
  // "shows nothing" are both real cases rather than one case and an assumption.
  repoCwd = join(projectsRoot, 'repo')
  const plainCwd = join(projectsRoot, 'plain')
  await mkdir(join(repoCwd, '.git'), { recursive: true })
  await mkdir(plainCwd, { recursive: true })
  await writeFile(join(repoCwd, '.git', 'HEAD'), 'ref: refs/heads/feature/status-bar\n')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      projects: [
        { id: 'id-repo', name: 'repo', slug: 'repo', cwd: repoCwd, presets: [] },
        { id: 'id-plain', name: 'plain', slug: 'plain', cwd: plainCwd, presets: [] },
      ],
      tabs: [],
      activeProjectId: 'id-repo',
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

test('the bar names the branch the active project is on', async () => {
  // The whole ref after refs/heads/, slashes included: `feature/status-bar` is
  // not `status-bar`.
  await expect(page.getByTestId('git-branch')).toHaveText('feature/status-bar')
})

test('a branch with no upstream gets no sync control', async () => {
  // This spec's repositories are a `.git` directory holding one HEAD file:
  // there is no remote and no upstream, so there is nothing to count against
  // and a Sync button here would fail every time it was pressed. The counted
  // case is gitsync.spec.ts, which builds real repositories.
  await expect(page.getByTestId('git-branch')).toBeVisible()
  await expect(page.getByTestId('git-sync')).toHaveCount(0)
  await expect(page.getByTestId('git-counts')).toHaveCount(0)
})

test('a project outside a repository leaves the bar empty without removing it', async () => {
  await page.getByTestId('project-id-plain').click()
  await expect(page.getByTestId('git-branch')).toHaveCount(0)
  // Still there, and still the same height: a bar that came and went would move
  // everything above it on every project switch.
  await expect(page.getByTestId('status-bar')).toBeVisible()
  const box = await page.getByTestId('status-bar').boundingBox()
  expect(box?.height).toBe(22)
})

test('a branch changed underneath the app reaches the bar', async () => {
  await page.getByTestId('project-id-repo').click()
  await expect(page.getByTestId('git-branch')).toHaveText('feature/status-bar')

  // Nothing tells main a checkout moved, so the bar polls. The timeout is well
  // over the 5s tick in StatusBar.tsx: what is under test is that the poll
  // happens at all, not how fast.
  await writeFile(join(repoCwd, '.git', 'HEAD'), 'ref: refs/heads/master\n')
  await expect(page.getByTestId('git-branch')).toHaveText('master', { timeout: 20_000 })
})
