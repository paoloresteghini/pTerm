/**
 * The git column: what it lists, and what it says when there is nothing to
 * list or no repository to list from.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { launchApp, killServer, expandColumn } from './harness'

const run = promisify(execFile)
const SOCKET = 'pterm-e2e'

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

test('lists a modified file and an untracked one', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await writeFile(join(repo, 'fresh.txt'), 'new\n', 'utf8')
  await open()

  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('gitpanel-unstaged-fresh.txt')).toBeVisible()
  await expect(page.getByTestId('gitpanel-unstaged-count')).toHaveText('2')
  await expect(page.getByTestId('gitpanel-branch')).toHaveText('master')
})

test('says so when the tree is clean', async () => {
  await open()
  await expect(page.getByTestId('gitpanel-empty')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toHaveCount(0)
})

test('says so when the project is not a repository', async () => {
  const bare = await mkdtemp(join(tmpdir(), 'pterm-e2e-bare-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [{ id: 'id-bare', name: 'Bare', slug: 'bare', cwd: bare, presets: [], activeTabId: null }],
      activeProjectId: 'id-bare',
      tabs: [],
    }),
    'utf8',
  )
  await open()
  await expect(page.getByTestId('gitpanel-norepo')).toBeVisible({ timeout: 15_000 })
  await rm(bare, { recursive: true, force: true })
})

test('staging a file moves it into the staged section', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await open()

  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('gitpanel-staged-tracked.txt')).toHaveCount(0)

  await page.getByTestId('gitpanel-stage-tracked.txt').click()

  await expect(page.getByTestId('gitpanel-staged-tracked.txt')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toHaveCount(0)
  await expect(page.getByTestId('gitpanel-staged-count')).toHaveText('1')
})

test('unstaging puts it back', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await gitIn(repo, ['add', 'tracked.txt'])
  await open()

  await expect(page.getByTestId('gitpanel-staged-tracked.txt')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('gitpanel-unstage-tracked.txt').click()
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('gitpanel-staged-tracked.txt')).toHaveCount(0)
})

test('commits the staged set and clears the message box', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await gitIn(repo, ['add', 'tracked.txt'])
  await open()

  await expect(page.getByTestId('gitpanel-staged-tracked.txt')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('gitpanel-message').fill('a real message')
  await page.getByTestId('gitpanel-commit').click()

  await expect(page.getByTestId('gitpanel-empty')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('gitpanel-message')).toHaveValue('')

  const { stdout } = await run('git', ['log', '-1', '--pretty=%s'], { cwd: repo })
  expect(stdout.trim()).toBe('a real message')
})

// The commit-all fallback, which is what makes the common case one click.
test('commits every tracked change when nothing is staged', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await writeFile(join(repo, 'fresh.txt'), 'new\n', 'utf8')
  await open()

  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('gitpanel-message').fill('sweep the tracked ones')
  await page.getByTestId('gitpanel-commit').click()

  // The untracked file is deliberately NOT swept in, so it survives as the
  // only remaining change.
  await expect(page.getByTestId('gitpanel-unstaged-fresh.txt')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toHaveCount(0)
})

test('refuses an empty message', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await open()
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('gitpanel-commit')).toBeDisabled()
})

// ⌘Enter is a second entry point to the same action the Commit button
// guards. An empty box must refuse through the keyboard exactly like a
// disabled button refuses a click: no IPC round trip at all, and therefore
// no 'Enter a commit message' error either. Without the fix, ⌘Enter called
// onCommit unconditionally, which still landed no commit (main's own guard
// catches an empty message too) but DID round-trip and surface that error,
// which is what this asserts against.
//
// `waitForTimeout` rather than an auto-retrying assertion: `not.toBeVisible`
// only waits for a CHANGE away from visible, and the error starts invisible
// either way, so it would pass before the round trip even lands. A fixed
// settle is what actually gives a bypassed guard time to show itself.
test('refuses an empty message on Cmd+Enter too', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await open()
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible({ timeout: 15_000 })

  const before = await run('git', ['log', '--oneline'], { cwd: repo })

  await page.getByTestId('gitpanel-message').press('Meta+Enter')
  await page.waitForTimeout(500)

  await expect(page.getByTestId('gitpanel-error')).toHaveCount(0)
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible()
  const after = await run('git', ['log', '--oneline'], { cwd: repo })
  expect(after.stdout.trim().split('\n').length).toBe(before.stdout.trim().split('\n').length)
})

// The guard against a peer session moving HEAD under the column. The list is
// read at one commit; the repository is then moved on behind the app's back;
// the commit must refuse rather than land somewhere the user never saw.
test('refuses to commit when the branch moved underneath it', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await open()
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('gitpanel-message').fill('mine')
  // Behind the app's back, between the read and the click.
  await writeFile(join(repo, 'other.txt'), 'other\n', 'utf8')
  await gitIn(repo, ['add', 'other.txt'])
  await gitIn(repo, ['commit', '-m', 'theirs'])

  await page.getByTestId('gitpanel-commit').click()
  await expect(page.getByTestId('gitpanel-error')).toContainText('moved', { timeout: 15_000 })

  const { stdout } = await run('git', ['log', '-1', '--pretty=%s'], { cwd: repo })
  expect(stdout.trim()).toBe('theirs')
})

test('discarding asks first, and cancelling changes nothing', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await open()
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('gitpanel-discard-tracked.txt').click()
  await expect(page.getByTestId('confirm-discard')).toBeVisible()
  await expect(page.getByTestId('confirm-discard')).toContainText('tracked.txt')

  await page.getByTestId('confirm-discard-cancel').click()
  await expect(page.getByTestId('confirm-discard')).toHaveCount(0)
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible()
  const kept = await run('git', ['diff', '--name-only'], { cwd: repo })
  expect(kept.stdout.trim()).toBe('tracked.txt')
})

test('confirming a discard restores a tracked file', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await open()
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('gitpanel-discard-tracked.txt').click()
  await page.getByTestId('confirm-discard-go').click()

  await expect(page.getByTestId('gitpanel-empty')).toBeVisible({ timeout: 15_000 })
  const after = await run('git', ['diff', '--name-only'], { cwd: repo })
  expect(after.stdout.trim()).toBe('')
})

// The half `git restore` cannot do: an untracked file has no committed state
// to return to, so discarding it is a deletion.
test('confirming a discard deletes an untracked file', async () => {
  await writeFile(join(repo, 'fresh.txt'), 'new\n', 'utf8')
  await open()
  await expect(page.getByTestId('gitpanel-unstaged-fresh.txt')).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('gitpanel-discard-fresh.txt').click()
  await page.getByTestId('confirm-discard-go').click()

  await expect(page.getByTestId('gitpanel-empty')).toBeVisible({ timeout: 15_000 })
  const listed = await run('git', ['status', '--porcelain'], { cwd: repo })
  expect(listed.stdout.trim()).toBe('')
})

test('stashing clears the list without asking', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf8')
  await open()
  await expect(page.getByTestId('gitpanel-unstaged-tracked.txt')).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('gitpanel-stash').click()

  await expect(page.getByTestId('gitpanel-empty')).toBeVisible({ timeout: 15_000 })
  const stashes = await run('git', ['stash', 'list'], { cwd: repo })
  expect(stashes.stdout.trim()).not.toBe('')
})
