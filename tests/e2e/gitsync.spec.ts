/**
 * The right-hand end of the status bar: how far the active project is from its
 * upstream, and the button that fetches, fast-forwards and pushes.
 *
 * Real repositories rather than the hand-built `.git` directories in
 * gitbranch.spec.ts, because everything here is about what git does — what
 * `rev-list` counts, and what `pull --ff-only` refuses. The remote is a bare
 * repository on disk, so nothing in this file touches a network or a
 * credential store.
 *
 * A fresh spec file with its own page. Within the file the tests share one page
 * and run in order: each leaves the repository somewhere the next one starts
 * from, and that is stated where it matters.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launchApp, killServer } from './harness'

const execFileAsync = promisify(execFile)
const SOCKET = 'pterm-e2e-gitsync'

let app: ElectronApplication
let page: Page
let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
/** Holds the bare remote and the second clone, away from the projects root. */
let gitRoot: string
let bare: string
let work: string
let other: string

/** git with an identity, failing loudly: setup that half-worked is a lie. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd },
  )
  return stdout.trim()
}

async function commit(cwd: string, name: string): Promise<string> {
  await writeFile(join(cwd, name), `${name}\n`)
  await git(cwd, ['add', name])
  await git(cwd, ['commit', '-m', name])
  return git(cwd, ['rev-parse', 'HEAD'])
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-gitsync-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-gitsync-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-gitsync-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-gitsync-settings-'))
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-gitsync-claude-'))
  gitRoot = await mkdtemp(join(tmpdir(), 'pterm-gitsync-git-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, JSON.stringify({ enabledPlugins: {} }))

  bare = join(gitRoot, 'remote.git')
  other = join(gitRoot, 'other')
  work = join(projectsRoot, 'work')
  await git(gitRoot, ['init', '--bare', bare])
  await git(gitRoot, ['clone', bare, work])
  await commit(work, 'first')
  await git(work, ['push', '-u', 'origin', 'main'])
  // A second clone standing in for everyone else: "someone pushed" below is a
  // real push into the same bare remote.
  await git(gitRoot, ['clone', bare, other])

  // Made before launch so the first test asserts a count the app read for
  // itself, rather than one it happened to watch appear.
  await commit(work, 'mine')

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 5,
      projects: [{ id: 'id-work', name: 'work', slug: 'work', cwd: work, presets: [] }],
      tabs: [],
      activeProjectId: 'id-work',
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
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome, gitRoot]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a local commit shows as waiting to go up', async () => {
  await expect(page.getByTestId('git-counts')).toHaveText('0↓ 1↑')
})

test('sync sends it to the remote', async () => {
  const mine = await git(work, ['rev-parse', 'HEAD'])
  await page.getByTestId('git-sync').click()
  await expect(page.getByTestId('git-counts')).toHaveText('0↓ 0↑')
  await expect(page.getByTestId('git-error')).toHaveCount(0)
  // The count going to zero is the app's own claim; this is the remote's.
  expect(await git(bare, ['rev-parse', 'main'])).toBe(mine)
})

test("someone else's push arrives on sync, not before", async () => {
  // The second clone has to catch up with what the previous test pushed before
  // it can push anything of its own — the remote would reject it otherwise, and
  // the rejection would be this file's own doing rather than anything the app
  // did.
  await git(other, ['pull'])
  const theirs = await commit(other, 'theirs')
  await git(other, ['push'])

  // Nothing fetches on a timer, so the bar cannot know yet. Given a beat to be
  // wrong in: the poll runs every 5s, and this must still read zero after one.
  await page.waitForTimeout(6000)
  await expect(page.getByTestId('git-counts')).toHaveText('0↓ 0↑')

  await page.getByTestId('git-sync').click()
  // Polled on the tip rather than asserted on the counts. This sync starts and
  // ends at `0↓ 0↑`, so a wait on the counts would be satisfied by the state
  // before the click and would let the rest of the test run mid-sync — which is
  // what it did before this comment was written.
  await expect.poll(() => git(work, ['rev-parse', 'HEAD'])).toBe(theirs)
  await expect(page.getByTestId('git-error')).toHaveCount(0)
  await expect(page.getByTestId('git-counts')).toHaveText('0↓ 0↑')
})

test('a diverged branch is refused, said out loud, and left alone', async () => {
  await git(other, ['pull'])
  const theirs = await commit(other, 'diverged')
  await git(other, ['push'])
  // Committed after the push, so the two sides have one commit each that the
  // other does not: exactly the shape `pull --ff-only` refuses.
  const mine = await commit(work, 'ours')

  await page.getByTestId('git-sync').click()

  // git's own words rather than a paraphrase, so the bar cannot describe a
  // thing git did not do.
  await expect(page.getByTestId('git-error')).toContainText('fast-forward')
  // The fetch ran before the refusal, which is what lets the bar show the
  // divergence the message is about.
  await expect(page.getByTestId('git-counts')).toHaveText('1↓ 1↑')
  // Nothing merged here and nothing pushed there.
  expect(await git(work, ['rev-parse', 'HEAD'])).toBe(mine)
  expect(await git(bare, ['rev-parse', 'main'])).toBe(theirs)
})
