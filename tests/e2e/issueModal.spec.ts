/**
 * The issue detail modal: opening it from a row, the state chip, Escape to
 * close, and the argv `gh issue view` was actually called with.
 *
 * Same scaffolding as `issuesList.spec.ts`, including `PTERM_GH_BIN` pointed
 * at the same stub. That stub answers every call from one fixture FILE
 * regardless of whether the call is `issue list` or `issue view`, so this
 * spec writes the list shape first, waits for the row, then overwrites the
 * fixture with the view shape before clicking: the stub rereads the file on
 * each invocation, so this is a legitimate way to give the two calls
 * different answers rather than a race with anything already in flight.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { launchApp, killServer, expandColumn } from './harness'

const run = promisify(execFile)
const SOCKET = 'pterm-e2e-issue-modal'
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

/** The row #42 lists with, in `gh issue list --json ...`'s field names. */
const LIST_ROW = {
  number: 42,
  title: 'Fix the resizer',
  state: 'CLOSED',
  stateReason: 'NOT_PLANNED',
  labels: [{ name: 'bug', color: 'aaaaaa' }],
  assignees: [{ login: 'paolo' }],
  comments: [],
  updatedAt: '2026-08-01T00:00:00Z',
  author: { login: 'paolo' },
}

// Distinct from the row title on purpose (`filed under the term
// zephyrwood`, not `Fix the resizer`), so a `toContainText` on the modal
// cannot pass by reading the row painted behind it.
const DETAIL = {
  ...LIST_ROW,
  body: 'The zephyrwood latch sticks when the frame is filed under 40 degrees.',
  url: 'https://github.com/o/n/issues/42',
  createdAt: '2026-07-01T00:00:00Z',
  comments: [],
}

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-modal-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-modal-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-modal-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-modal-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-modal-claude-'))

  repo = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-modal-repo-'))
  await gitIn(repo, ['init'])
  await writeFile(join(repo, 'tracked.txt'), 'one\n', 'utf8')
  await gitIn(repo, ['add', 'tracked.txt'])
  await gitIn(repo, ['commit', '-m', 'first'])
  await gitIn(repo, ['remote', 'add', 'origin', 'https://github.com/o/n.git'])

  scratchDir = await mkdtemp(join(tmpdir(), 'pterm-e2e-issue-modal-scratch-'))
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

test('opens an issue from its row, shows its state and body, and closes on Escape', async () => {
  await writeFile(fixturePath, JSON.stringify([LIST_ROW]), 'utf8')
  app = await launchApp({
    socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir,
    ghBin: GH_BIN, ghStubFixture: fixturePath, ghStubLog: stubLog,
  })
  page = await app.firstWindow()
  await expandColumn(page, 'issues')
  await expect(page.getByTestId('issue-row-42')).toBeVisible({ timeout: 15_000 })

  // Swap in the view shape before the click triggers `gh issue view`; the
  // list call already ran and read the array above.
  await writeFile(fixturePath, JSON.stringify(DETAIL), 'utf8')
  await page.getByTestId('issue-row-42').click()

  await expect(page.getByTestId('issue-modal')).toBeVisible({ timeout: 15_000 })
  // Content the modal shows and nothing else on screen does: the row behind
  // it says "Fix the resizer", never "zephyrwood".
  await expect(page.getByTestId('issue-modal')).toContainText(
    'zephyrwood latch sticks when the frame is filed under 40 degrees',
  )
  await expect(page.getByTestId('issue-state')).toHaveText('Closed as not planned')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('issue-modal')).toHaveCount(0)

  await expect.poll(() => readFile(stubLog, 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('"view"')
  const lines = (await readFile(stubLog, 'utf8')).trim().split('\n')
  const viewCall = lines.map((line) => JSON.parse(line) as string[]).find((argv) => argv.includes('view'))
  expect(viewCall).toBeDefined()
  expect(viewCall).toEqual(expect.arrayContaining(['issue', 'view', '42', '--repo', 'o/n']))
})
