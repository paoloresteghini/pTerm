/**
 * The split surface, seen by a test for the first time.
 *
 * Two tests on the `prcli-e2e-splits` socket: ⌘D turns one pane into two
 * inside a single tab, backed by two tmux sessions, with the new pane taking
 * the selection and ⌥⌘← giving it back; and a ⌘D on a pane too narrow to halve
 * is refused, with the reason on screen and no second session made.
 *
 * Before this file no test anywhere in this repo had rendered a split.
 * `tabs.spec.ts` says so in its own "what this file does NOT see": nothing
 * pressed ⌘D, every group rendered exactly one box, and so `PaneDivider` — a
 * component built only for `index > 0` (`src/renderer/App.tsx:805-807`) — was
 * never constructed once in the whole suite.
 *
 * **What this file does NOT see** — read off this file's own text unless a
 * line says measured or names another file:
 *
 * - **the dividers.** Two panes do construct one `PaneDivider` now, but no
 *   assertion here names `dividers-` or `pane-divider`, and nothing drags one.
 *   That a strip is drawn in the right place, and that dragging it moves share
 *   between exactly two panes, are both untested at this level;
 * - **more than two panes, and the second axis.** Only one ⌘D is ever pressed,
 *   so `axis` is always the `dir` the shortcut asked for (`App.tsx:175` takes
 *   `row.layout.dir` only once a tab is `drawn.length > 1`). ⇧⌘D, and the
 *   ruling that a second split joins the tab's existing axis whichever
 *   shortcut asked, are not exercised;
 * - **⌥⌘→/↑/↓.** Only `left` is pressed. `paneInDirection`'s cross-axis
 *   refusal (`workspace.ts:304`) and its no-wrap ends are covered by unit
 *   tests, not here;
 * - **the row floor.** The refusal test squeezes the window along the column
 *   axis only, so `MIN_PANE_ROWS` and the `'rows'` half of the message are
 *   never the branch taken;
 * - **closing one pane of a split, restoring a split across a relaunch, and a
 *   dead pane inside one.** Nothing here closes, relaunches or kills;
 * - **the OS keyboard layer.** ⌘D and ⌥⌘← are dispatched into the window by
 *   Playwright, as everywhere else in this suite.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames } from './harness'

const run = promisify(execFile)
const SOCKET = 'prcli-e2e-splits'

/**
 * The floor `App.tsx` refuses a column split under, and the width at which
 * half of a pane falls below it.
 *
 * `App.tsx:191-193` refuses when `Math.max(1, Math.floor(cols / 2)) < 20`,
 * which is exactly `cols < 40`. Written out because the refusal test waits for
 * that inequality to hold and would otherwise be waiting for a magic number.
 */
const MIN_PANE_COLS = 20
const TOO_NARROW_BELOW = MIN_PANE_COLS * 2

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string

// Every launch in this file goes through the shared harness, so all four
// overrides are set by construction rather than by another copy of one env
// block that could drift away from the other specs'.
const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, userDataDir })

/**
 * Write a config holding one project, selected.
 *
 * The app no longer opens a terminal on its own: a project has to exist for
 * `+` to have anywhere to open one. Driving the UI to add it is not possible
 * here — `choose-folder` opens a native dialog Playwright cannot touch — so
 * the config file is seeded directly. Returns the project's directory.
 */
async function seedProject(slug: string, name: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `prcli-proj-${slug}-`))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [{ id: `id-${slug}`, name, slug, cwd, presets: [], activeTabId: null }],
      activeProjectId: `id-${slug}`,
      tabs: [],
    }),
    'utf8',
  )
  return cwd
}

/** The active group's pane boxes, in on-screen order, as bare pane ids. */
async function paneIds(window: Page): Promise<string[]> {
  const boxes = window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]')
  // Non-empty first: `.map` over nothing is `[]`, and `[]` compares equal to
  // itself in every assertion that would otherwise catch a broken selector.
  await expect(boxes.first()).toBeVisible()
  return (
    await boxes.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.testid ?? ''))
  ).map((id) => id.replace('pane-', ''))
}

/**
 * The column count tmux holds for `name`'s window.
 *
 * This is the renderer's own `grid.cols` travelled through IPC, not an
 * independent measurement: `Terminal.tsx:84` sends `term.cols` on every fit,
 * `SessionManager.resize` records it and pushes it on with
 * `resize-window -x <cols>` (`manager.ts:1304-1324`, `adapter.ts:305-307`), and
 * `paneGrid` — the function `splitActive` reads — returns that same
 * `term.cols`. So waiting on this number waits on the quantity the split guard
 * actually tests, rather than on a pixel width that has to be assumed to map
 * to one.
 */
async function windowCols(name: string): Promise<number> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_width}',
  ])
  return Number(stdout.trim())
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-splits-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-splits-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-splits-root-'))
  projectCwd = await seedProject('scratch', 'Scratch')
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-splits-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⌘D splits the active tab into two panes, in one tab, with two sessions', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const before = await paneIds(window)
  expect(before).toHaveLength(1)

  await window.keyboard.press('Meta+d')

  // Two boxes in ONE group. That is the whole claim of a split, and the raw
  // pane count alone would not make it — two tabs would also give two boxes,
  // in two groups. The `:scope >` inside `terminal-active` is what carries it:
  // both boxes are direct children of the single visible group container.
  await expect(
    window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
  ).toHaveCount(2)

  // A split is a second tmux SESSION in the same session group, not a
  // split-window. `manager.splitTab` makes the window itself.
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  const after = await paneIds(window)
  expect(after).toContain(before[0])
  expect(after.filter((id) => id !== before[0])).toHaveLength(1)

  // The pane the user asked for is the one the keyboard talks to, and the
  // ring only appears where there is a choice to make.
  await expect(window.getByTestId(`pane-${after[1]}`)).toHaveAttribute('data-active', 'true')
  await expect(window.getByTestId(`pane-${after[0]}`)).toHaveAttribute('data-active', 'false')

  // ⌥⌘← moves the selection back along the tab's axis.
  await window.keyboard.press('Alt+Meta+ArrowLeft')
  await expect(window.getByTestId(`pane-${after[0]}`)).toHaveAttribute('data-active', 'true')

  await app.close()
})

test('⌘D on a pane too narrow to halve is refused, and says why', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const [session] = await sessionNames(SOCKET)

  // Squeeze the window until half of it is under MIN_PANE_COLS (20). The
  // width in PIXELS is not the quantity the guard tests — it tests
  // `grid.cols`, which is what Terminal.tsx's fit reports — so this resizes
  // and then waits for the pane's own reported geometry rather than assuming
  // a pixel width maps to a column count. See `windowCols` for why tmux's
  // `#{window_width}` IS that reported geometry and not a second opinion on it.
  //
  // 560px: the sidebar and the right panel are `w-52 shrink-0` a side
  // (`Sidebar.tsx:78`, `RightPanel.tsx:13`), so ~416px never reaches the
  // terminal and the pane is left a strip far narrower than 40 columns. The
  // poll below is what makes the test depend on the column count rather than
  // on that arithmetic being right.
  //
  // `app.evaluate` + `BrowserWindow.setSize` because Playwright cannot resize
  // an Electron BrowserWindow through the page API. This is not a mechanism
  // unique to this file: `launch.spec.ts`'s `runs against overridden paths,
  // never the developer's own` reads `process.env` in the main process the
  // same way. A `launchApp` window-size option was the alternative and is
  // worse: all five of its options are required rather than
  // optional-with-a-default on purpose, and `tests/unit/e2eSafety.test.ts`
  // rests on that — its `refuses a %s outside the temp root` cases feed each of
  // the four paths, and its socket cases the fifth, a real value one at a time
  // and require the throw to beat the launch. Adding an optional option is a
  // step back towards the defaults that argument exists to keep out.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(560, 800)
  })
  await expect
    .poll(() => windowCols(session), { timeout: 20_000 })
    .toBeLessThan(TOO_NARROW_BELOW)

  await window.keyboard.press('Meta+d')

  // Refused: still one box, and the reason is on screen. Asserting the TEXT,
  // not just visibility of `startup-error` — `toBeVisible` on an element that
  // only exists when `error` is set is close to honest, but the message names
  // the floor and the axis, and a guard that fired for the wrong axis would
  // still be visible.
  await expect(window.getByTestId('startup-error')).toContainText(
    `at least ${MIN_PANE_COLS} columns`,
  )

  // Then settle before asserting the two counts, because both are assertions
  // that something did NOT happen and neither can be waited for. `toHaveCount`
  // returns on its first match and a split that had not landed yet still
  // measures 1, so checking it the instant the message appears would pass
  // whether the split was refused or merely slow — which is not a hypothetical
  // here: measured 2026-08-02 with this guard mutated to `if (false)`, the
  // second box appeared 190ms after the keypress and the second session 201ms
  // after it, and an unsettled version of this test passed against a build
  // that split anyway. 1500ms is ~7x that, and is the same wait
  // `tabs.spec.ts` settles for before its own non-change assertions.
  await window.waitForTimeout(1500)
  await expect(
    window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
  ).toHaveCount(1)
  // And no second session was made — the refusal is BEFORE the IPC call.
  expect(await sessionNames(SOCKET)).toHaveLength(1)

  await app.close()
})
