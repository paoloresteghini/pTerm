/**
 * The history overlay, from the one key that opens it to what ends up on the
 * shell's prompt.
 *
 * Five tests on the `pterm-e2e-history` socket, each launching its own app so
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
 * related reason: half these assertions are substring searches against a whole
 * screen, and a screen holds the shell's prompt as well as the test's own
 * text. A prompt printing an unabbreviated `mkdtemp` path would put
 * `/var/folders/` on the line, and `'folders'.includes('older')` is true.
 *
 * **Every pane in this file runs zsh against `PANE_RC`, not the developer's
 * own dotfiles.** `ZDOTDIR` points at the temp directory below, so the prompt,
 * the history file and everything else about the pane's shell is something
 * this file wrote and can therefore assert on. Two things depend on that: the
 * prompt is a fixed string, so `openPane` can wait for the shell to be READY
 * rather than for the screen to be non-blank (a prompt that paints in two
 * stages satisfies non-blank while the real prompt is still coming), and the
 * pane's own command history holds exactly one line, which is what lets the
 * passthrough test below assert on the text zsh recalls instead of on the fact
 * that something changed.
 *
 * **What this file does NOT see:**
 *
 * - **the zsh hook actually recording anything.** Every entry here is written
 *   by the test. That the `preexec` hook produces this file's format is Task
 *   2's, proved by running zsh;
 * - **a `claude` or `editor` pane passing Up through.** The pane-type branch of
 *   the passthrough rule is executed here for `preset` panes, which take the
 *   same branch and need no `claude` binary on the machine. An `editor` pane
 *   has no terminal and no key handler to reach;
 * - **which unit a relative time picks.** A row's `2h ago` half is asserted
 *   here only for its shape, in the scope test. The boundaries at 60 seconds,
 *   60 minutes and 24 hours are `tests/unit/historyAgo.test.ts`, because the
 *   seconds either side of each of them are one apart and nothing that launches
 *   an app can pin a clock.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames, capturePane, expandColumn } from './harness'

const SOCKET = 'pterm-e2e-history'

/**
 * The command texts the seeds use. See the header for why they are prefixed.
 *
 * `BOTTOM` exists so the list is three rows deep rather than two, which is what
 * lets the clamp be tested by a press that MOVES the selection. No token is a
 * substring of another, because half the assertions here are substring searches
 * against a whole screen.
 */
const NEWER = 'echo hist-newer'
const OLDER = 'echo hist-older'
const BOTTOM = 'echo hist-bottom'

/**
 * The prompt every pane in this file draws, and the one command in every
 * pane's own zsh history.
 *
 * `PANE_PROMPT` has no `%` escapes and no cwd in it, so the string on screen
 * is this constant and nothing has to be predicted. `RECALLED` shares no
 * substring with the `hist-` tokens above, because the passthrough test puts
 * it on a prompt line and other assertions read whole screens.
 */
const PANE_PROMPT = 'pTermE2E$'
const RECALLED = 'echo pterm-recall-probe'

/**
 * The rc file the pane's zsh reads, given `ZDOTDIR` points at its directory.
 *
 * `HISTFILE` is set here rather than passed in the environment because macOS's
 * `/etc/zshrc` assigns `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` before any
 * user rc file runs, which would overwrite an environment value. Setting it in
 * this file, which runs after `/etc/zshrc`, is what makes it stick. `HISTSIZE`
 * has to be non-zero for zsh to read the file back at all.
 */
const PANE_RC = (historyFile: string): string =>
  [`PS1='${PANE_PROMPT} '`, `HISTFILE=${historyFile}`, 'HISTSIZE=200', 'SAVEHIST=200', ''].join('\n')

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string
let zshrcDir: string
let zshrcPath: string
let paneHistoryPath: string

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
    // The same directory, because for a real user the file this app edits and
    // the file their shell reads ARE one file. Pointing both here is what
    // gives the panes a prompt and a command history this file owns; see the
    // option's comment in `harness.ts` for how it reaches them.
    zdotdir: zshrcDir,
  })

/**
 * The declared preset the pane-type passthrough test launches from.
 *
 * `echo` first so the pane has a readiness signal on screen, then `cat`, which
 * lives until the pane is killed and echoes what is typed at it. tmux hands a
 * session's command to `sh -c`, so this runs as written.
 */
const PRESET_LABEL = 'holdopen'
const PRESET_READY = 'PRESETREADY'
const PRESET_COMMAND = `echo ${PRESET_READY}; cat`

/** Write a config holding one project, selected, and return its directory. */
async function seedProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pterm-proj-scratch-'))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [
        {
          id: 'id-scratch',
          name: 'Scratch',
          slug: 'scratch',
          cwd,
          // Declared for every test in this file, though only the pane-type
          // passthrough test clicks it. The Presets column is collapsed on a
          // fresh profile, so an unclicked preset puts nothing on screen and
          // costs the other tests no width.
          presets: [{ id: 'preset-holdopen', label: PRESET_LABEL, command: PRESET_COMMAND }],
          activeTabId: null,
        },
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
 * What it waits for is `PANE_PROMPT`, which this file's own `PANE_RC` sets, and
 * that is doing two jobs. It is a readiness check that "the screen is not
 * blank" cannot make: a prompt drawn in two passes, which several popular zsh
 * prompt frameworks do, is non-blank while the real prompt is still on its way.
 * It is also the proof that `ZDOTDIR` reached this pane at all. If it did not,
 * the shell reads whatever rc file it would otherwise have read, every
 * assertion downstream is about a machine's own configuration again, and this
 * poll fails here rather than letting that happen quietly.
 */
async function openPane(): Promise<{ app: ElectronApplication; window: Page; session: string }> {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const session = (await sessionNames(SOCKET))[0]
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain(PANE_PROMPT)
  return { app, window, session }
}

/** The pane's rows, trailing blanks trimmed off each, for exact-line assertions. */
async function paneLines(session: string): Promise<string[]> {
  return (await capturePane(SOCKET, session)).split('\n').map((line) => line.trimEnd())
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-history-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-history-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-history-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-history-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-history-claude-'))
  zshrcDir = await mkdtemp(join(tmpdir(), 'pterm-history-zshrc-'))
  zshrcPath = join(zshrcDir, '.zshrc')
  paneHistoryPath = join(zshrcDir, '.zsh_history')
  await writeFile(zshrcPath, PANE_RC(paneHistoryPath))
  // One line, so `Up` in a pane recalls a string this file chose. Written
  // fresh per test: a pane that exits appends to this file, and the
  // passthrough test asserts on what the FIRST press brings back.
  await writeFile(paneHistoryPath, `${RECALLED}\n`)
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
    { ts: 1, cwd: projectCwd, cmd: BOTTOM },
    { ts: 2, cwd: projectCwd, cmd: OLDER },
    { ts: 3, cwd: projectCwd, cmd: NEWER },
  ])
  const { window, session } = await openPane()

  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toBeVisible()

  // Newest first, and the newest starts selected.
  await expect(window.getByTestId('history-row-0')).toHaveAttribute('data-selected', 'true')
  await expect(window.getByTestId('history-row-0')).toHaveText(new RegExp(NEWER))
  await expect(window.getByTestId('history-row-1')).toHaveText(new RegExp(OLDER))
  await expect(window.getByTestId('history-row-2')).toHaveText(new RegExp(BOTTOM))

  // A real change to wait on: row 1 reads `false` until this press.
  await window.keyboard.press('ArrowDown')
  await expect(window.getByTestId('history-row-1')).toHaveAttribute('data-selected', 'true')
  await expect(window.getByTestId('history-row-0')).toHaveAttribute('data-selected', 'false')

  await window.keyboard.press('ArrowDown')
  await expect(window.getByTestId('history-row-2')).toHaveAttribute('data-selected', 'true')

  /*
   * Both clamps, each proved by a press that MOVES the selection.
   *
   * Asserting the clamp directly cannot work: a clamp is a non-change, so
   * `toHaveAttribute` after the clamping press would already hold before it and
   * an auto-retrying assertion would satisfy itself without waiting for
   * anything. This asks the question one press later instead. From the bottom
   * row, an extra Down and then an Up must land on row 1; a wrap would have
   * taken the extra Down to row 0 and the Up would have stayed there, so the
   * final press is the one that changes row 1 from `false` to `true` and the
   * two implementations disagree about the row it changes.
   */
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-row-1')).toHaveAttribute('data-selected', 'true')

  // The same shape at the top, which nothing tested before: up to row 0, one
  // more Up that must do nothing, then a Down that must reach row 1. A wrap at
  // the top would be at row 2 by then and the Down would clamp there.
  await window.keyboard.press('ArrowUp')
  await window.keyboard.press('ArrowUp')
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

  /*
   * Half three: the pane can be typed at again, and the screen is still clean
   * one keystroke later.
   *
   * The order of these three is deliberate and was arrived at by running the
   * sabotage. The weak marker poll goes FIRST because it is the only one of the
   * three that a submitted command would not also break, so it is what lets
   * execution reach the reading below it. The exact-line reading then runs
   * against a screen the marker proves is strictly later than the first
   * reading's. The strong same-line form goes last, where nothing depends on
   * reaching it.
   */
  await window.keyboard.type('REFOCUSED')
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain('REFOCUSED')

  // Still not run, on that later screen.
  expect(await paneLines(session)).not.toContain('hist-older')

  // And the marker landed on the SAME line as the picked command, which is a
  // stronger claim than either of the two above: it says the prompt was never
  // submitted AND that the keyboard came back to the pane it was taken from.
  expect(await capturePane(SOCKET, session)).toContain(`${OLDER}REFOCUSED`)
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

/*
 * The mouse, which nothing touched until this test and which is how the
 * overlay's worst state was reached.
 *
 * Every key the overlay handles arrives through a React `onKeyDown` on its own
 * container, so it only fires for events targeted at that container or inside
 * it. A click on a row or on the padding used to land on a non-focusable
 * element, sending DOM focus to `body`, which is an ancestor rather than a
 * descendant: from there Escape did nothing, the arrows did nothing, and a
 * second Up was refused because the overlay was already open. The list sat over
 * the pane and the only way out was to switch tab.
 */
test('a click keeps the keyboard, a click on a row picks it, and a click on the terminal dismisses', async () => {
  await seedHistory([
    { ts: 1, cwd: projectCwd, cmd: OLDER },
    { ts: 2, cwd: projectCwd, cmd: NEWER },
  ])
  const { window, session } = await openPane()

  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toBeVisible()

  // A click on a part of the overlay that is not a row must leave the keyboard
  // where it was. The arrow afterwards is the proof: it can only move the
  // selection if the keydown still reaches the container's handler.
  await window.getByTestId('history-scope').click()
  await window.keyboard.press('ArrowDown')
  await expect(window.getByTestId('history-row-1')).toHaveAttribute('data-selected', 'true')

  // And the exit still works after a click, which is the part that made the old
  // state a trap rather than a nuisance.
  await window.keyboard.press('Escape')
  await expect(window.getByTestId('history-overlay')).toBeHidden()

  // Clicking a row picks that row, not the selected one: this reopens at row 0
  // and clicks row 1.
  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toBeVisible()
  await expect(window.getByTestId('history-row-0')).toHaveAttribute('data-selected', 'true')
  await window.getByTestId('history-row-1').click()
  await expect(window.getByTestId('history-overlay')).toBeHidden()
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain(OLDER)

  // The one way focus can leave the overlay that no mousedown of its own can
  // stop: a click on the part of the terminal still showing above it. xterm
  // takes focus, so this counts as dismissing the overlay rather than stranding
  // it. Positioned near the top corner because the overlay owns the bottom.
  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toBeVisible()
  await window.getByTestId('terminal').click({ position: { x: 20, y: 8 } })
  await expect(window.getByTestId('history-overlay')).toBeHidden()

  // And the pane is live, so the dismissal did not leave the keyboard nowhere.
  await window.keyboard.type('AFTERCLICK')
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain('AFTERCLICK')
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

  /*
   * The assertion this test exists for, and the only one of the three here
   * that separates the two states.
   *
   * An overlay that never opened is exactly what a SWALLOWED Up looks like
   * too, since with nothing to show there is nothing for it to open. Measured
   * 2026-08-06 by sabotaging the passthrough guard to always report "handled":
   * the overlay still never appeared and the surrounding checks stayed green.
   * What only a passed-through Up can do is reach zsh's line editor, and the
   * one line `beforeEach` put in this pane's history file is what it brings
   * back.
   *
   * Asserted as the exact line rather than as "the screen changed". A diff
   * against an earlier capture is satisfied by anything that repaints the pane
   * within the timeout, including a prompt that finishes drawing after the
   * first read, with the key press contributing nothing.
   */
  await expect
    .poll(async () => await paneLines(session), { timeout: 20_000 })
    .toContain(`${PANE_PROMPT} ${RECALLED}`)

  // And the keyboard is still the pane's: a marker typed now goes to the pty,
  // which it could not do if an overlay had opened and taken focus for its
  // filter.
  await window.keyboard.type('PASSTHROUGH')
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain('PASSTHROUGH')
})

/*
 * The transition nothing else in this file crosses: empty to non-empty, in one
 * running app.
 *
 * Every other test seeds `history.jsonl` before the app launches, so it starts
 * on the non-empty side; the passthrough test starts on the empty side and
 * stays there. The path a real user takes is neither. They launch with no
 * history, install the integration from Settings, open a shell pane because
 * that row tells them to, run a command, and press Up. If the answer fetched
 * at launch is never asked again, that press and every press after it passes
 * through, and the feature looks broken for the whole session with no way to
 * tell it apart from the documented passthrough.
 */
test('history that appears after launch becomes reachable without a restart', async () => {
  const { window } = await openPane()

  // The empty side, pinned: this is a real starting state, not an assumption.
  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toHaveCount(0)

  // What installing the hook and running one command amounts to, with no
  // project switch and no relaunch in between.
  await seedHistory([{ ts: 1, cwd: projectCwd, cmd: NEWER }])

  // Pressed in a loop because the press that finds the list empty is the one
  // that asks for it again, and the answer arrives over IPC: it is the NEXT
  // press that can open anything. A build that never re-asks stays at zero
  // here however many times Up is pressed, which is the whole point.
  await expect
    .poll(async () => {
      await window.keyboard.press('ArrowUp')
      return await window.getByTestId('history-overlay').count()
    }, { timeout: 20_000 })
    .toBe(1)
  await expect(window.getByTestId('history-row-0')).toHaveText(new RegExp(NEWER))
})

/*
 * The pane-type half of the passthrough rule, which no test executed until
 * now.
 *
 * `preset` rather than `claude`, so this needs no `claude` binary on the
 * machine: both types take the identical branch in `requestHistory`, which
 * asks only whether the pane's type is `shell`. The pane runs `cat`, which
 * lives until it is killed and echoes what is typed at it, so the pty's own
 * view of the keystrokes is readable from tmux.
 *
 * The seeded `history.jsonl` is what makes this discriminating rather than
 * decorative: it holds an entry for this project, so the overlay has something
 * to show and a build that stopped checking the pane's type would open it here.
 */
test('Up reaches a preset pane rather than opening the overlay', async () => {
  await seedHistory([{ ts: 1, cwd: projectCwd, cmd: NEWER }])

  const app = await launch()
  const window = await app.firstWindow()
  // Launched by clicking the preset rather than seeded into `config.json`.
  // Restore only reattaches panes whose tmux session is live (`restore.ts`
  // skips a saved row whose session is gone rather than reopening it), so a
  // seeded `preset` row on a socket this test just killed would be pruned
  // before anything rendered.
  await expandColumn(window, 'presets')
  await window.getByTestId(`preset-${PRESET_LABEL}`).click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const session = (await sessionNames(SOCKET))[0]
  // `cat` draws no prompt, so the readiness signal is the echo in front of it.
  // Without waiting for it, an Up pressed before the pty is attached is lost
  // and the assertion below would fail for the wrong reason.
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain(PRESET_READY)

  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toHaveCount(0)

  /*
   * The Up itself, read off the pty rather than inferred from a later marker.
   *
   * `cat` leaves the tty in canonical mode with echo on, so the escape
   * sequence xterm sends for Up is echoed back in caret notation. Measured
   * 2026-08-06 against a tmux pane running `cat`: pressing Up then typing
   * `PRESETMARKER` captured as `^[[APRESETMARKER`, on one line. That makes the
   * marker do a second job, since it can only land on the same line as the
   * arrow if the arrow got there first.
   */
  await window.keyboard.type('PRESETMARKER')
  await expect
    .poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain('^[[APRESETMARKER')
})
