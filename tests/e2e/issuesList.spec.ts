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

/**
 * Writes `rows` as the fixture file and launches with the stub reading it.
 *
 * `delayMs` stalls every `gh` call the stub answers, which is the only way to
 * hold the column's in-flight window open long enough to assert on it. A real
 * `gh issue list` takes seconds against a busy repository; the two tests that
 * pass a delay are about what the column shows for exactly that stretch.
 */
async function openWithFixture(rows: unknown[], delayMs?: number): Promise<void> {
  await writeFile(fixturePath, JSON.stringify(rows), 'utf8')
  app = await launchApp({
    socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir,
    ghBin: GH_BIN, ghStubFixture: fixturePath, ghStubLog: stubLog, ghStubDelayMs: delayMs,
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

test('the count keeps the filter its rows were fetched under while the next one loads', async () => {
  await openWithFixture(TWO_ISSUES, 2500)
  await expect(page.getByTestId('issue-row-42')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('issues-count')).toHaveText('2 open')

  await page.getByTestId('issues-state-closed').click()

  // The gate, not the assertion. `issues-refresh` goes disabled when `load`
  // sets `loading`, one render AFTER the click's own state change has already
  // painted, so reaching this point proves the heading has been re-rendered
  // under the new filter. Asserting the count straight after the click would
  // race that render and pass on the pre-click text.
  await expect(page.getByTestId('issues-refresh')).toBeDisabled()

  // The two open rows are still on screen, deliberately: this column does not
  // blank a list it is refreshing. What it must not do is caption them with a
  // filter the server was never asked about.
  await expect(page.getByTestId('issue-row-42')).toBeVisible()
  await expect(page.getByTestId('issues-count')).toHaveText('2 open')

  // And once the closed fetch lands both halves move together. The stub
  // answers every call from the same fixture regardless of `--state`, so what
  // arrives is two rows again; the point is that the word changes only when
  // the rows it counts do.
  await expect(page.getByTestId('issues-count')).toHaveText('2 closed', { timeout: 20_000 })
})

test('a project switch takes the previous project rows off screen', async () => {
  // The reason this matters is `quickClose`: it pairs the row number it is
  // given with the LIVE project id, so a row left over from the project the
  // user just left would close that number in the repository they switched to.
  const other = await mkdtemp(join(tmpdir(), 'pterm-e2e-issues-list-repo2-'))
  try {
    await gitIn(other, ['init'])
    await writeFile(join(other, 'tracked.txt'), 'one\n', 'utf8')
    await gitIn(other, ['add', 'tracked.txt'])
    await gitIn(other, ['commit', '-m', 'first'])
    await gitIn(other, ['remote', 'add', 'origin', 'https://github.com/other/second.git'])
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({
        version: 3,
        projects: [
          { id: 'id-repo', name: 'Repo', slug: 'repo', cwd: repo, presets: [], activeTabId: null },
          { id: 'id-other', name: 'Other', slug: 'other', cwd: other, presets: [], activeTabId: null },
        ],
        activeProjectId: 'id-repo',
        tabs: [],
      }),
      'utf8',
    )

    await openWithFixture(TWO_ISSUES, 2500)
    await expect(page.getByTestId('issue-row-42')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('issues-repo')).toHaveText('o/n')

    await page.keyboard.press('Meta+Digit2')
    // Same gate rule as the filter test above: the rail's own `data-active`
    // flips in the render the switch causes, so waiting on it means the panel
    // has re-rendered too and the assertions below are not racing it.
    await expect(page.getByTestId('project-id-other')).toHaveAttribute('data-active', 'true')

    await expect(page.getByTestId('issue-row-42')).toHaveCount(0)
    await expect(page.getByTestId('issues-repo')).toHaveCount(0)
    await expect(page.getByTestId('issues-loading')).toBeVisible()

    await expect(page.getByTestId('issues-repo')).toHaveText('other/second', { timeout: 20_000 })
  } finally {
    await rm(other, { recursive: true, force: true })
  }
})

test('the count stays inside the column when the repo slug is too long for it', async () => {
  // Geometry, not text. `toContainText('1 open')` passes on the broken layout
  // too: with the slug and the count inside one `truncate` span, the count is
  // still a text node, still in the DOM, and Playwright still calls it
  // visible. It is simply clipped out of sight, which is how this shipped.
  await gitIn(repo, ['remote', 'set-url', 'origin',
    'https://github.com/paoloresteghini/prcli-issues-smoke.git'])
  await openWithFixture([TWO_ISSUES[0]])
  await expect(page.getByTestId('issue-row-42')).toBeVisible({ timeout: 15_000 })

  const boxes = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="issues-panel"]')
    const slug = document.querySelector('[data-testid="issues-repo"]')
    const count = document.querySelector('[data-testid="issues-count"]')
    if (!panel || !slug || !count) return null
    return {
      panelRight: panel.getBoundingClientRect().right,
      count: count.getBoundingClientRect(),
      slugClient: slug.clientWidth,
      slugScroll: slug.scrollWidth,
    }
  })
  expect(boxes).not.toBeNull()

  // The premise: this slug really is wider than the column gives it, so the
  // assertions below are about a genuinely tight row rather than one with
  // room to spare. Without this a wider default width would quietly turn the
  // rest of this test into a no-op.
  expect(boxes!.slugScroll).toBeGreaterThan(boxes!.slugClient)

  // The property: the name is what shortens, and the count is still on screen.
  expect(boxes!.count.width).toBeGreaterThan(0)
  expect(boxes!.count.right).toBeLessThanOrEqual(boxes!.panelRight)
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
