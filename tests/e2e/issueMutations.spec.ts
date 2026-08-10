/**
 * The issue modal's write path: close with each reason, reopen, a comment,
 * and one mutation that fails.
 *
 * Same scaffolding as `issueModal.spec.ts`: the stub answers every `gh` call
 * from one fixture FILE, so each test writes the list shape first, waits for
 * the row, then overwrites the fixture with the detail shape before clicking
 * it open. What matters here is not what the modal shows afterwards, since
 * the stub keeps no state and a second `issue view` would just echo the same
 * fixture back — it is the argv `PTERM_GH_STUB_LOG` recorded for the
 * mutating call, which is the contract main and the renderer actually agree
 * on.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { launchApp, killServer, expandColumn } from './harness'

const run = promisify(execFile)
const SOCKET = 'pterm-e2e-issue-mutations'
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

/** #42's row, in `gh issue list --json ...`'s own field names. */
const OPEN_ROW = {
  number: 42,
  title: 'Fix the resizer',
  state: 'OPEN',
  stateReason: null,
  labels: [],
  assignees: [],
  comments: [],
  updatedAt: '2026-08-01T00:00:00Z',
  author: { login: 'paolo' },
}

const OPEN_DETAIL = {
  ...OPEN_ROW,
  body: 'Something broke.',
  url: 'https://github.com/o/n/issues/42',
  createdAt: '2026-07-01T00:00:00Z',
  comments: [],
}

const CLOSED_ROW = { ...OPEN_ROW, state: 'CLOSED', stateReason: 'COMPLETED' }
const CLOSED_DETAIL = { ...OPEN_DETAIL, state: 'CLOSED', stateReason: 'COMPLETED' }

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-mutations-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-mutations-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-mutations-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-mutations-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-mutations-claude-'))

  repo = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-mutations-repo-'))
  await gitIn(repo, ['init'])
  await writeFile(join(repo, 'tracked.txt'), 'one\n', 'utf8')
  await gitIn(repo, ['add', 'tracked.txt'])
  await gitIn(repo, ['commit', '-m', 'first'])
  await gitIn(repo, ['remote', 'add', 'origin', 'https://github.com/o/n.git'])

  scratchDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-mutations-scratch-'))
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
 * Launches with `row` as the list fixture, waits for its row, then swaps in
 * `detail` before clicking the row open. Mirrors `issueModal.spec.ts`'s own
 * `beforeEach` body, kept as a helper here since every test in this file
 * needs the modal open before it does anything mutating.
 */
async function openIssue(row: { number: number }, detail: unknown): Promise<void> {
  await writeFile(fixturePath, JSON.stringify([row]), 'utf8')
  app = await launchApp({
    socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir,
    ghBin: GH_BIN, ghStubFixture: fixturePath, ghStubLog: stubLog,
  })
  page = await app.firstWindow()
  await expandColumn(page, 'issues')
  await expect(page.getByTestId(`issue-row-${row.number}`)).toBeVisible({ timeout: 15_000 })

  await writeFile(fixturePath, JSON.stringify(detail), 'utf8')
  await page.getByTestId(`issue-row-${row.number}`).click()
  await expect(page.getByTestId('issue-modal')).toBeVisible({ timeout: 15_000 })
}

/** Every argv the stub has logged so far, parsed back out of the log file. */
async function loggedArgv(): Promise<string[][]> {
  const text = await readFile(stubLog, 'utf8').catch(() => '')
  return text
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[])
}

test('closing as completed records the close argv with a completed reason', async () => {
  await openIssue(OPEN_ROW, OPEN_DETAIL)

  await page.getByTestId('issue-close-completed').click()

  await expect
    .poll(async () => (await loggedArgv()).some((argv) => argv.includes('close')), { timeout: 15_000 })
    .toBe(true)
  const closeCall = (await loggedArgv()).find((argv) => argv.includes('close'))
  expect(closeCall).toEqual(['issue', 'close', '42', '--repo', 'o/n', '--reason', 'completed'])
})

test('closing as not planned passes the reason as one unquoted argv element', async () => {
  await openIssue(OPEN_ROW, OPEN_DETAIL)

  await page.getByTestId('issue-close-not-planned').click()

  await expect
    .poll(async () => (await loggedArgv()).some((argv) => argv.includes('close')), { timeout: 15_000 })
    .toBe(true)
  const closeCall = (await loggedArgv()).find((argv) => argv.includes('close'))
  expect(closeCall).toBeDefined()
  const reasonIndex = closeCall!.indexOf('--reason')
  expect(reasonIndex).toBeGreaterThanOrEqual(0)
  expect(closeCall![reasonIndex + 1]).toBe('not planned')
  expect(closeCall!.some((arg) => arg.includes('"') || arg.includes("'"))).toBe(false)
})

test('reopening records no --reason', async () => {
  await openIssue(CLOSED_ROW, CLOSED_DETAIL)

  await page.getByTestId('issue-reopen').click()

  await expect
    .poll(async () => (await loggedArgv()).some((argv) => argv.includes('reopen')), { timeout: 15_000 })
    .toBe(true)
  const reopenCall = (await loggedArgv()).find((argv) => argv.includes('reopen'))
  expect(reopenCall).toEqual(['issue', 'reopen', '42', '--repo', 'o/n'])
})

test('submitting a comment records the comment argv', async () => {
  await openIssue(OPEN_ROW, OPEN_DETAIL)

  await page.getByTestId('issue-comment-input').fill('Looks fixed to me.')
  await page.getByTestId('issue-comment-submit').click()

  await expect
    .poll(async () => (await loggedArgv()).some((argv) => argv.includes('comment')), { timeout: 15_000 })
    .toBe(true)
  const commentCall = (await loggedArgv()).find((argv) => argv.includes('comment'))
  expect(commentCall).toEqual(['issue', 'comment', '42', '--repo', 'o/n', '--body-file', '-'])
})

test('a close attempt under no-auth leaves issue-error visible', async () => {
  await openIssue(OPEN_ROW, OPEN_DETAIL)

  // `issue-modal` is visible the instant the dialog shell opens, before the
  // `issuesGet` it fires has resolved: waiting on it alone races the flip
  // below against that still-in-flight fetch, which can lose and fail the
  // GET itself. The close button only renders once detail has actually
  // landed, so waiting for it here is what makes the GET's own `gh` call
  // done before anything below touches the stub's mode.
  await expect(page.getByTestId('issue-close-completed')).toBeVisible({ timeout: 15_000 })

  // The list and the view above both already succeeded, reading the fixture
  // written before the row was clicked. Flipping the mode NOW, in the main
  // process's own environment, only reaches the mutating call that follows:
  // `gh()` in `src/main/gh/run.ts` spreads `process.env` fresh on every
  // invocation, so this is a legitimate way to fail one specific call rather
  // than a race with anything already in flight.
  await app!.evaluate(() => {
    process.env.PTERM_GH_STUB_MODE = 'no-auth'
  })

  await page.getByTestId('issue-close-completed').click()

  await expect(page.getByTestId('issue-error')).toBeVisible({ timeout: 15_000 })
})
