/**
 * The issues column's list: what it draws from a real `issue list` reply,
 * search, and the empty state for one failure it can reach without any
 * network at all.
 *
 * `gh` is never the real CLI here: `PTERM_GH_BIN` points every call at
 * `fixtures/gh-stub.mjs`, which answers from a fixture file or a canned
 * failure rather than talking to GitHub. The project's cwd still has to be a
 * real git repository with a GitHub `origin`, the way `gitpanel.spec.ts`
 * builds its repo, because `resolveRepo` in `src/main/gh/issues.ts` reads the
 * remote with real `git` before `gh` is ever invoked.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { launchApp, killServer, expandColumn } from './harness'

const run = promisify(execFile)
const SOCKET = 'pterm-e2e-issues-list'
// `__dirname` rather than `import.meta.url`: this file runs through
// Playwright's own CJS transform, which has no `import.meta` to read.
const GH_BIN = join(__dirname, 'fixtures', 'gh-stub.mjs')

let userDataDir: string
let configDir: string
let projectsRoot: string
let repo: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let scratchDir: string
let fixturePath: string
let stubLog: string
let app: ElectronApplication | undefined
let page: Page

/** git, with an identity of its own so no developer config is needed. */
async function gitIn(cwd: string, args: string[]): Promise<void> {
  await run('git', ['-c', 'user.name=pterm', '-c', 'user.email=pterm@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=master', ...args], { cwd })
}

/** Two issues, in `gh issue list --json ...`'s own field names. */
const TWO_ISSUES = [
  {
    number: 42,
    title: 'Fix the resizer',
    state: 'OPEN',
    stateReason: null,
    labels: [{ name: 'bug', color: 'aaaaaa' }],
    assignees: [],
    comments: [],
    updatedAt: '2026-08-01T00:00:00Z',
    author: { login: 'paolo' },
  },
  {
    number: 38,
    title: 'Add a column',
    state: 'OPEN',
    stateReason: null,
    labels: [],
    assignees: [],
    comments: [{ author: { login: 'paolo' }, body: 'hi', createdAt: '2026-08-01T00:00:00Z' }],
    updatedAt: '2026-07-20T00:00:00Z',
    author: { login: 'paolo' },
  },
]

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-list-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-list-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-list-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-list-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-list-claude-'))

  repo = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-list-repo-'))
  await gitIn(repo, ['init'])
  await writeFile(join(repo, 'tracked.txt'), 'one\n', 'utf8')
  await gitIn(repo, ['add', 'tracked.txt'])
  await gitIn(repo, ['commit', '-m', 'first'])
  await gitIn(repo, ['remote', 'add', 'origin', 'https://github.com/o/n.git'])

  scratchDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-list-scratch-'))
  fixturePath = join(scratchDir, 'issues.json')
  stubLog = join(scratchDir, 'argv.log')

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
  for (const dir of [userDataDir, configDir, projectsRoot, repo, claudeSettingsDir, claudeHome, scratchDir]) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Writes `rows` as the fixture file and launches with the stub reading it. */
async function openWithFixture(rows: unknown[]): Promise<void> {
  await writeFile(fixturePath, JSON.stringify(rows), 'utf8')
  app = await launchApp({
    socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir,
    ghBin: GH_BIN, ghStubFixture: fixturePath, ghStubLog: stubLog,
  })
  page = await app.firstWindow()
  await expandColumn(page, 'issues')
}

/** Launches with a canned failure mode instead of a fixture. */
async function openWithMode(mode: string): Promise<void> {
  app = await launchApp({
    socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir,
    ghBin: GH_BIN, ghStubMode: mode, ghStubLog: stubLog,
  })
  page = await app.firstWindow()
  await expandColumn(page, 'issues')
}

test('lists the fixture issues as their own rows', async () => {
  await openWithFixture(TWO_ISSUES)
  await expect(page.getByTestId('issue-row-42')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('issue-row-38')).toBeVisible()
})

test('typing into the search box leaves only the matching row', async () => {
  await openWithFixture(TWO_ISSUES)
  await expect(page.getByTestId('issue-row-42')).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('issues-search').fill('resizer')
  await expect(page.getByTestId('issue-row-42')).toBeVisible()
  await expect(page.getByTestId('issue-row-38')).toHaveCount(0)
})

test('clearing the search restores every row', async () => {
  await openWithFixture(TWO_ISSUES)
  await expect(page.getByTestId('issue-row-42')).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('issues-search').fill('resizer')
  await expect(page.getByTestId('issue-row-38')).toHaveCount(0)

  await page.getByTestId('issues-search').fill('')
  await expect(page.getByTestId('issue-row-42')).toBeVisible()
  await expect(page.getByTestId('issue-row-38')).toBeVisible()
})

test('the list call names the repository by --repo', async () => {
  await openWithFixture(TWO_ISSUES)
  await expect(page.getByTestId('issue-row-42')).toBeVisible({ timeout: 15_000 })

  await expect.poll(() => readFile(stubLog, 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('"list"')

  const lines = (await readFile(stubLog, 'utf8')).trim().split('\n')
  const listCall = lines.map((line) => JSON.parse(line) as string[]).find((argv) => argv.includes('list'))
  expect(listCall).toBeDefined()
  expect(listCall).toContain('--repo')
  expect(listCall).toContain('o/n')
})

test('shows the no-auth empty state and no list when gh is not signed in', async () => {
  await openWithMode('no-auth')
  await expect(page.getByTestId('issues-empty-no-auth')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('issues-list')).toHaveCount(0)
})

test('a fixture of exactly 200 issues shows the truncated count', async () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index + 1}`,
    state: 'OPEN',
    stateReason: null,
    labels: [],
    assignees: [],
    comments: [],
    updatedAt: '2026-08-01T00:00:00Z',
    author: { login: 'paolo' },
  }))
  await openWithFixture(rows)
  await expect(page.getByTestId('issues-count')).toHaveText('200+', { timeout: 15_000 })
})
