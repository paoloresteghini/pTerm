/**
 * The history overlay, from the one key that opens it to what ends up on the
 * shell's prompt.
 *
 * Four tests on the `prcli-e2e-history` socket, each launching its own app so
 * no test inherits a page another one typed into. Every one of them seeds
 * `history.jsonl` directly rather than running commands in a pane: the file is
 * what the zsh hook writes, the overlay reads nothing else, and seeding it
 * means these tests never execute a command in the developer's shell.
 *
 * **The assertion this file exists for is "the command did NOT run."** The DOM
 * cannot distinguish a command typed onto the prompt from one that was
 * submitted, so both halves are read out of tmux with `capturePane`.
 *
 * The obvious spelling of that assertion is wrong, and was measured to be wrong
 * on 2026-08-06 before this file was written. `capture-pane -p` joins the
 * pane's rows with newlines and pads out to the pane's height, so a prompt line
 * holding typed-but-unrun text ends in a newline exactly like a line of output
 * does. Both states, captured from a real pane of this app that day:
 *
 *     typed, not run:  ["…scratch-k76dyU % echo hist-older", "", "", …]
 *     actually run:    ["…scratch-k76dyU % echo hist-older", "hist-older",
 *                       "…scratch-k76dyU %", "", …]
 *
 * `not.toContain('hist-older\n')` therefore fails in BOTH states, including the
 * one that means the feature works. What actually separates them is the second
 * line: running `echo hist-older` puts `hist-older` on a line OF ITS OWN. So
 * the test below splits the capture into lines and asserts no line IS that
 * token.
 *
 * The command texts are prefixed rather than a bare `older`/`newer` for a
 * related reason: a substring search runs against a screen that also holds the
 * shell's prompt, and what a prompt puts on screen is the developer's own
 * configuration rather than anything this suite chose. The one on this machine
 * abbreviates the cwd to its last component; one that printed the whole
 * `mkdtemp` path would put `/var/folders/` on the line, and
 * `'folders'.includes('older')` is true.
 *
 * **What this file does NOT see:**
 *
 * - **the zsh hook actually recording anything.** Every entry here is written
 *   by the test. That the `preexec` hook produces this file's format is Task
 *   2's, proved by running zsh;
 * - **a `claude`, `preset` or `editor` pane passing Up through.** Only the
 *   `shell` branch and the empty-list branch of the passthrough rule are
 *   pressed here; the pane-type branch is read off `App.tsx` and not executed;
 * - **the relative timestamps.** Rows are matched by command text, so the
 *   `2h ago` half of a row is drawn here and never asserted on. `historyAgo`
 *   in `HistoryOverlay.tsx` is a pure function of two numbers and has no test
 *   anywhere as of this file being written;
 * - **anything about the developer's real shell history.** The panes here run
 *   the machine's real login shell with the developer's own rc file, the way
 *   every other e2e spec's panes do. Nothing here submits a line to it: the one
 *   Enter pressed belongs to the overlay, and every marker typed afterwards is
 *   left sitting on the prompt unexecuted.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames, capturePane } from './harness'

const SOCKET = 'prcli-e2e-history'

/** The command texts the seeds use. See the header for why they are prefixed. */
const OLDER = 'echo hist-older'
const NEWER = 'echo hist-newer'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let zshrcDir: string
let zshrcPath: string

const launch = (): Promise<ElectronApplication> =>
  launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
    // Nothing in the overlay reads an rc file, so this is defence rather than
    // a requirement: the shell-history install lives one Settings click away
    // from every launch, and the cost of pointing it somewhere safe is a line.
    zshrc: zshrcPath,
  })

/** Write a config holding one project, selected, and return its directory. */
async function seedProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'prcli-proj-scratch-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [
        { id: 'id-scratch', name: 'Scratch', slug: 'scratch', cwd, presets: [], activeTabId: null },
      ],
      activeProjectId: 'id-scratch',
      tabs: [],
    }),
    'utf8',
  )
  return cwd
}

/** Write `history.jsonl` in the app's config dir, oldest line first. */
async function seedHistory(entries: { ts: number; cwd: string; cmd: string }[]): Promise<void> {
  await writeFile(
    join(configDir, 'history.jsonl'),
    entries.map((entry) => JSON.stringify({ tab: 't', ...entry })).join('\n') + '\n',
    'utf8',
  )
}

/**
 * A pane with one tab open, its shell at a prompt, and the window that holds it.
 *
 * Waiting for the PROMPT and not only for the session is load-bearing, and it
 * was measured rather than assumed. The tmux session exists a moment before zsh
 * has drawn anything, and a command typed into that gap arrives mangled: on
 * 2026-08-06 this same flow, without the wait below, put
 * `mecho hist-older` on the pane, a stray byte in front of the command. That
 * would not have failed `toContain('echo hist-older')`, which matches inside
 * the mangled string, but it WOULD have silently defused the exact-line
 * assertion that the command never ran, because running `mecho hist-older`
 * prints `zsh: command not found` instead of `hist-older`.
 *
 * A blank pane is the state before the prompt and a non-blank one is the state
 * after it, so "has drawn anything at all" is the whole test. Spelled that way
 * rather than by matching prompt text, which is the developer's own and not
 * this suite's to predict.
 */
async function openPane(): Promise<{ app: ElectronApplication; window: Page; session: string }> {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const session = (await sessionNames(SOCKET))[0]
  await expect
    .poll(async () => (await capturePane(SOCKET, session)).trim(), { timeout: 20_000 })
    .not.toBe('')
  return { app, window, session }
}

/** The pane's rows, trailing blanks trimmed off each, for exact-line assertions. */
async function paneLines(session: string): Promise<string[]> {
  return (await capturePane(SOCKET, session)).split('\n').map((line) => line.trimEnd())
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-history-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-history-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-history-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-history-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-history-claude-'))
  zshrcDir = await mkdtemp(join(tmpdir(), 'prcli-history-zshrc-'))
  zshrcPath = join(zshrcDir, '.zshrc')
  await writeFile(zshrcPath, '# left alone by every test in this file\n')
  projectCwd = await seedProject()
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [
    userDataDir,
    configDir,
    projectsRoot,
    projectCwd,
    claudeSettingsDir,
    claudeHome,
    zshrcDir,
  ]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Up opens history, arrows move, and Enter types the command without running it', async () => {
  await seedHistory([
    { ts: 1, cwd: projectCwd, cmd: OLDER },
    { ts: 2, cwd: projectCwd, cmd: NEWER },
  ])
  const { window, session } = await openPane()

  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toBeVisible()

  // Newest first, and the newest starts selected.
  await expect(window.getByTestId('history-row-0')).toHaveAttribute('data-selected', 'true')
  await expect(window.getByTestId('history-row-0')).toHaveText(new RegExp(NEWER))
  await expect(window.getByTestId('history-row-1')).toHaveText(new RegExp(OLDER))

  // A real change to wait on: row 1 reads `false` until this press.
  await window.keyboard.press('ArrowDown')
  await expect(window.getByTestId('history-row-1')).toHaveAttribute('data-selected', 'true')
  await expect(window.getByTestId('history-row-0')).toHaveAttribute('data-selected', 'false')

  // Clamped at the end rather than wrapping back to the top.
  await window.keyboard.press('ArrowDown')
  await expect(window.getByTestId('history-row-1')).toHaveAttribute('data-selected', 'true')

  await window.keyboard.press('Enter')
  await expect(window.getByTestId('history-overlay')).toBeHidden()

  // Half one: the selected command reached the prompt.
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain(OLDER)

  // Half two, and the point of the feature: it was NOT run. Running
  // `echo hist-older` would put `hist-older` on a line of its own, which is the
  // one thing the two states do not share. See this file's header for the
  // captured bytes and for why the substring spelling cannot tell them apart.
  // Read before anything else is typed, so the screen under it is the one the
  // pick left behind.
  expect(await paneLines(session)).not.toContain('hist-older')

  // Half three: the pane can be typed at again. Without this, an overlay that
  // took focus on mount and never gave it back would satisfy everything above
  // and leave a pane the keyboard could not reach.
  await window.keyboard.type('REFOCUSED')
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain(`${OLDER}REFOCUSED`)
})

test('Esc dismisses without typing anything', async () => {
  await seedHistory([
    { ts: 1, cwd: projectCwd, cmd: OLDER },
    { ts: 2, cwd: projectCwd, cmd: NEWER },
  ])
  const { window, session } = await openPane()

  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(window.getByTestId('history-overlay')).toBeHidden()

  // Nothing was typed, and the pane is live again: the marker proves the
  // keyboard reaches the pty after the dismissal, so the absence of the
  // commands above is not the absence of a working pane.
  await window.keyboard.type('DISMISSED')
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain('DISMISSED')
  expect(await capturePane(SOCKET, session)).not.toContain('hist-')
})

test('typing filters the list, and Tab widens the scope to every project', async () => {
  const elsewhere = join(projectsRoot, 'another-project')
  await seedHistory([
    { ts: 1, cwd: elsewhere, cmd: 'echo hist-outside' },
    { ts: 2, cwd: projectCwd, cmd: 'echo hist-inside' },
  ])
  const { window } = await openPane()

  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toBeVisible()

  // Scoped to this project: the entry recorded elsewhere is not offered.
  const rows = window.locator('[data-testid^="history-row-"]')
  await expect(rows).toHaveCount(1)
  await expect(window.getByTestId('history-row-0')).toHaveText(/echo hist-inside/)

  // Typing filters. `outside` matches nothing inside this project, so the list
  // empties: a change from one row to none, not a value that already held.
  await window.keyboard.type('outside')
  await expect(rows).toHaveCount(0)
  await expect(window.getByTestId('history-empty')).toBeVisible()

  // Tab widens to every project. The filter stays, so the row that appears can
  // only have come from the wider scope.
  await window.keyboard.press('Tab')
  await expect(window.getByTestId('history-scope')).toHaveText('all projects')
  await expect(rows).toHaveCount(1)
  await expect(window.getByTestId('history-row-0')).toHaveText(/echo hist-outside/)

  // And back, because the spec's key WIDENS and narrows rather than only
  // widening. An implementation that always set the wider scope would satisfy
  // every assertion above this line.
  await window.keyboard.press('Tab')
  await expect(window.getByTestId('history-scope')).toHaveText('this project')
  await expect(rows).toHaveCount(0)

  // Clearing the filter brings this project's own entry back, and every row
  // carries a relative time worked out from its `ts`. That is the reason the
  // hook records a timestamp at all, and nothing else in the suite draws one.
  await window.getByTestId('history-filter').fill('')
  await expect(rows).toHaveCount(1)
  await expect(window.getByTestId('history-row-0')).toHaveText(/(just now|\d+[mhd] ago)$/)
})

// The rule from the spec, not an optimisation: with nothing to show, Up still
// belongs to zsh. Swallowing it would take the shell's own recall away and
// give nothing back.
test('Up reaches the shell when there is no history to show', async () => {
  // No history.jsonl at all, which is also the state of a machine that has
  // never installed the shell integration.
  const { window, session } = await openPane()

  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toHaveCount(0)

  // The absence of an overlay is only half of it, and on its own it would pass
  // for a key that never arrived anywhere. This marker goes to the pty, which
  // it could not do if an overlay had opened and taken focus for its filter.
  await window.keyboard.type('PASSTHROUGH')
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain('PASSTHROUGH')
})
