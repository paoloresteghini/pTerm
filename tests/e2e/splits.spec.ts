/**
 * The split surface, seen by a test for the first time.
 *
 * Seven tests on the `prcli-e2e-splits` socket. Three are about making a split:
 * ⌘D turns one pane into two inside a single tab, backed by two tmux sessions,
 * with the new pane taking the selection and ⌥⌘← giving it back; a ⌘D on a pane
 * too narrow to halve is refused, with the reason on screen and no second
 * session made; and one pane of a split killed outright leaves a tombstone in
 * its own slot, with the sibling still drawn, until the overlay's own Restart
 * clears it and brings the session back.
 *
 * Four are about the DRAG, and they are the first thing anywhere in this repo
 * to press a pointer down on a divider: a drag moves the seam, follows the
 * cursor linearly, reflows tmux behind it and is written to disk on release; a
 * drag run past a pane's floor pins there and reopens when the same gesture
 * comes back; a drag on the first seam of a THREE-pane row leaves the far pane
 * untouched; and a drag on a tab holding a tombstone is kept, routed by name
 * through main's row, and survives the tombstone's restart.
 *
 * `tests/unit/dividers.test.ts` covers this gesture by reading `App.tsx` and
 * `PaneDivider.tsx` as TEXT — vitest runs `environment: 'node'`, so it has no
 * DOM and no layout — and its own header lists what that cannot see. Three of
 * those items are now here. **Measured 2026-08-02**, two mutations that leave
 * `dividers.test.ts` 11 of 11 green while visibly breaking the app: `App.tsx`'s
 * `slice(0, index)` becoming `slice(0, index - 1)`, and `PaneDivider`'s
 * `${offset * 100}%` becoming a constant `0%`. Both fail this file, on the seam
 * placement assertion, by 423.5 pixels.
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
 * - **the `col` axis. Every drag here is horizontal**, and it is the largest
 *   single gap in this file. A `col` tab takes the other branch of all three
 *   things the drag tests assert: `PaneDivider` positions on `top` rather than
 *   `left` and measures `offsetHeight` rather than `offsetWidth`
 *   (`PaneDivider.tsx:126,72`), `grabFor` reads `grid.rows` against
 *   `MIN_PANE_ROWS` rather than `grid.cols` against `MIN_PANE_COLS`
 *   (`workspace.ts:438,447`), and the reflow travels as `-y` rather than `-x`.
 *   Nothing here executes any of them;
 * - **the seam arithmetic anywhere it is hard.** The seam placement assertion
 *   is made on a two-pane row at 0.5/0.5, which is the one arrangement where
 *   `PaneDivider`'s own derivation says the error is smallest — it bounds the
 *   k-th seam of an n-pane tab at `n − 1.5` pixels, so half a pixel here, and
 *   1.6px at the third seam of a four-pane row. The three-pane tests drag a
 *   seam but assert nothing about where it was drawn;
 * - **that tmux got wider, not that it got wider BY THE RIGHT AMOUNT.** The
 *   reflow poll is `toBeGreaterThan(colsBefore)`. A pane that grew by 160
 *   pixels and pushed tmux one column would satisfy it;
 * - **⇧⌘D, and the second axis of the split shortcut.** Every ⌘D here asks for
 *   `row`, so the ruling that a second split joins the tab's existing axis
 *   whichever shortcut asked is not exercised — `App.tsx:175` takes
 *   `row.layout.dir` only once a tab is `drawn.length > 1`, and no test here
 *   ever disagrees with it;
 * - **⌥⌘→/↑/↓.** Only `left` is pressed. `paneInDirection`'s cross-axis
 *   refusal (`workspace.ts:304`) and its no-wrap ends are covered by unit
 *   tests, not here;
 * - **the row floor.** The refusal test squeezes the window along the column
 *   axis only, so `MIN_PANE_ROWS` and the `'rows'` half of the message are
 *   never the branch taken;
 * - **closing one pane of a split, and restoring a split across a relaunch.**
 *   Nothing here closes a pane or relaunches the app, so `closedPane` is
 *   unreached and no restore ever hands this file a row it did not just make.
 *   In particular no drag is ever read back off disk into a rendered layout:
 *   `savedRatio` reads the file, it does not watch the app read it;
 * - **`withKeptPanes`' merge, PARTLY — and the split is worth stating, because
 *   it moved when the three-pane tests were added.** The function has exactly
 *   two call sites: `applyTabShape` (`workspace.ts:830`), whose own doc says
 *   "Only `split` uses this", and the `closedPane` case (`workspace.ts:1071`).
 *   Restore is not one of them — it dispatches `restored`, which builds no row
 *   through here — and nothing in this file closes a pane, so every entry is
 *   from a ⌘D. **Measured 2026-08-02, a throw on entry: 6 failed, 1 passed**,
 *   the passing one being the refusal test, whose ⌘D is turned away before any
 *   IPC call and so never produces a shape to fold in.
 *
 *   The FIRST ⌘D of a tab always enters with `prior === undefined` — a tab has
 *   no row until its first split (`tabs: []` is seeded and `opened` adds none)
 *   — and returns at the function's first line, reaching not one line of the
 *   successor-anchored merge below it. The second ⌘D does not: by then the tab
 *   has a row. **Measured the same day, a throw placed after
 *   `if (!prior) return next`: 5 passed, 2 failed** — exactly the two tests
 *   that press ⌘D twice. So the merge body IS reached here now, though only
 *   with `missing` empty: no tombstone has been made at the moment either of
 *   those splits happens, so the early `missing.length === 0` return is taken
 *   and the successor-anchored re-anchoring loop below it is still executed by
 *   nothing in this file — **measured the same day, a throw placed after that
 *   return: 7 passed**.
 *
 *   Neither tombstone test adds any of it. `died` is one line that writes
 *   `state.dead` and leaves the row alone, and restart dispatches `opened`,
 *   which rewrites `state.panes` and never `state.tabs`. The order asserted
 *   after a death is therefore `boxesOfRow` walking the row the split already
 *   wrote, untouched by any merge;
 * - **most of the dead-pane overlay.** The two tombstone tests render `DeadPane`
 *   and click `pane-restart-<id>`, which is the whole of what is witnessed
 *   here. `pane-dismiss-<id>` is never clicked, `pane-dot-<id>`'s colour is
 *   never read — the dot is asserted nowhere, so `ended` vs `crashed` after a
 *   `kill -9` is not a distinction this file draws — and nothing checks that
 *   dismissing a tombstone hands its width back to its sibling;
 * - **`register.ts:756-758`'s `owed` write, and this is stated because the
 *   drag-on-a-tombstone test looks like it covers it and does not.** That loop
 *   writes the dragged share into main's private in-memory `tombstones` map. No
 *   assertion in this file can see it: the tombstone's width on screen comes
 *   from the RENDERER's row, which `opened` leaves untouched
 *   (`workspace.ts:958-975`) and which `withKeptPanes` re-anchors a tombstone
 *   from on every later rebuild (`workspace.ts:759-796`), so the renderer's own
 *   value wins over main's claim in every gesture reachable from here — and in
 *   the row main writes to disk the claim cancels, because `sharesAroundClaims`
 *   scales the live kids into `1 - claim` and `inLiveFrame` immediately divides
 *   them by their own total again. **Measured 2026-08-02, that `for` loop
 *   deleted: this file stayed 7 of 7 green.** Where it IS witnessed:
 *   `tests/integration/persistence.test.ts`'s `keeps what a tombstone is owed
 *   current, so the next split reserves the dragged share`, which needs a
 *   second pane dead AND restarted before the claim stops cancelling. So the
 *   write is covered — it is simply not covered *here*, and the brief that
 *   asked for this file called it unwitnessed on a premise that had already
 *   gone stale;
 * - **`grabPane`'s three refusal guards, as a user gesture.** `grabFor` returns
 *   null on a missing pair, on `boxes.length !== row.layout.kids.length` and on
 *   either identity check (`workspace.ts:430-435`). All three are pinned by
 *   `workspace.test.ts`; nothing here drives a pointer into one. The
 *   drag-on-a-tombstone test asserts the OPPOSITE of the second — that a
 *   tombstoned kid keeps the row's length, so the guard does not fire;
 * - **the OS keyboard layer.** ⌘D and ⌥⌘← are dispatched into the window by
 *   Playwright, as everywhere else in this suite.
 *
 * **And it does not discharge the owed manual verification of the drag.** Two
 * independent reasons, and both hold with every test in this file green. The
 * `col` axis is entirely unwatched, per the first bullet. And a
 * `boundingBox()` reading is not a person watching a window: it cannot see
 * tearing, a divider that jumps before it tracks, a cursor that does not change
 * to `col-resize`, or an xterm that redraws at the wrong size for a frame.
 * What this file buys is that the gesture is **wired, linear, floored,
 * conservative and persisted**. What it leaves owed is that the gesture **looks
 * right**, on both axes. Those are different claims and only the first is
 * testable here.
 *
 * **No assertion read off the rendered panes can witness a uniform rescale of
 * main's row, so "the row sums to 1" is never checked on screen.**
 * `withKeptPanes` divides the incoming shares by their own sum
 * (`workspace.ts:770-773`) and `boxesOfRow` divides each kept share by the kept
 * total (`workspace.ts:567,575`). A row of `[0.6, 0.4]` and a row of `[6, 4]`
 * render identically, pixel for pixel. Such an assertion would be true by
 * construction and could still fail for nothing; it belongs in
 * `workspace.test.ts`, where the vector itself is visible.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

/**
 * The ratios `main` has written down for the tab founded by `tabId`, or
 * `undefined` when no row on disk is keyed by it.
 *
 * A tab row's `id` is its FOUNDER PANE's id — there is no separate tab id to
 * read — so every caller here passes the first element of `paneIds`.
 *
 * The vector is main's, not the renderer's, and the two are deliberately in
 * different frames whenever the tab holds a tombstone: `routeShares` keeps only
 * the kids main's row names and divides them by their own total
 * (`src/main/ipc/shares.ts:267-273`), so a drag that moved a tombstone's share
 * shows up here only through what it did to the LIVE kids' proportions. Every
 * assertion below reads this as a proportion of the saved kids and never as a
 * whole-tab share.
 */
async function savedRatio(tabId: string): Promise<number[] | undefined> {
  const raw = await readFile(join(configDir, 'config.json'), 'utf8')
  const config = JSON.parse(raw) as {
    tabs?: { id: string; layout: { ratio: number[] } }[]
  }
  return config.tabs?.find((row) => row.id === tabId)?.layout.ratio
}

/**
 * A new tab split until it holds `count` panes, with the count asserted on
 * screen and in tmux before anything is allowed to drag it.
 *
 * `:scope >` inside `terminal-active` for the same reason the ⌘D test gives:
 * a bare `[data-testid^="pane-"]` also matches `pane-divider`,
 * `pane-restart-*`, `pane-dismiss-*` and `pane-dot-*`, and a raw pane count
 * across the whole window would be satisfied by two TABS as readily as by one
 * split. Each ⌘D splits whichever pane is active, which is the pane the
 * previous ⌘D made, so `count` panes cost `count` tmux sessions and `count - 1`
 * dividers.
 */
async function splitTabInto(window: Page, count: number): Promise<string[]> {
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  for (let made = 1; made < count; made += 1) {
    await window.keyboard.press('Meta+d')
    await expect(
      window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
    ).toHaveCount(made + 1)
    await expect
      .poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 })
      .toBe(made + 1)
  }
  const ids = await paneIds(window)
  expect(ids).toHaveLength(count)
  return ids
}

/** The box of pane `id`, which must exist. */
async function paneBox(window: Page, id: string): Promise<{ x: number; width: number }> {
  const box = await window.getByTestId(`pane-${id}`).boundingBox()
  if (!box) throw new Error(`no bounding box for pane ${id}`)
  return box
}

/**
 * The width of pane `id` once the frame a pointer move produced has been
 * painted.
 *
 * A fixed settle, not `expect.poll`, and that is the point: these readings are
 * compared against each OTHER — three equal cursor steps must produce three
 * equal width gains — so a poll that returned on the first frame in which the
 * width had merely started moving would compare a settled reading against an
 * unsettled one and manufacture the very non-linearity the comparison exists to
 * detect. 200ms is measured against nothing; it is the same order as the
 * 1500ms this file already settles for before its non-change assertions, scaled
 * down because a single React commit is not an IPC round trip. If a drag test
 * flakes on a loaded machine, raise it.
 */
async function widthAfterFrame(window: Page, id: string): Promise<number> {
  await window.waitForTimeout(200)
  return (await paneBox(window, id)).width
}

/**
 * The pid of the process running in one of THIS socket's sessions, checked
 * before anything is allowed to signal it.
 *
 * The one test in this file that kills a process is the only place in the
 * suite where a mis-parse is not a failed assertion but real damage: this
 * machine runs a default tmux server carrying the developer's own work, and
 * `kill -9 ''` or `kill -9` on whatever a wrong lookup returned is not
 * something a green suite would tell you about afterwards. So every step of
 * the derivation is narrowed rather than trusted:
 *
 * - `-L SOCKET` is fixed, so the lookup can only ever see sessions this file
 *   created. There is no parameter for it and no call site that could pass
 *   `default`;
 * - `=${session}:` is an EXACT session name (tmux's `=` prefix), and the
 *   caller builds that name from the app's own pane id, having first asserted
 *   the name is one of `sessionNames(SOCKET)`;
 * - exactly one line must come back, and it must be a positive integer.
 *   Anything else — no server, an unknown session, a window that somehow held
 *   two panes — throws here rather than travelling on to `kill` as `''`, `NaN`
 *   or a second pid nobody meant to name.
 *
 * `tests/integration/pane-death.test.ts` reads `#{pane_pid}` the same way for
 * the same reason; this is that shape with the guard written out.
 */
async function panePid(session: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'list-panes', '-t', `=${session}:`, '-F', '#{pane_pid}',
  ])
  const pids = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  if (pids.length !== 1 || !/^[1-9][0-9]*$/.test(pids[0])) {
    throw new Error(
      `refusing to kill: expected exactly one numeric pane pid for "${session}" on ` +
        `socket ${SOCKET}, got ${JSON.stringify(pids)}`,
    )
  }
  return pids[0]
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

/**
 * The first test anywhere in this repo to render `DeadPane`.
 *
 * Measured, 2026-08-02, before this test existed: mutating `DeadPane` to
 * return `null` left `status.spec.ts` — the only other spec that kills a
 * session — 10 of 10 green, because its `a dead tab lingers, then restarts`
 * drives `TabBar`'s `restart-<id>` and never the overlay's
 * `pane-restart-<id>`. The overlay had shipped unwitnessed.
 */
test('a killed pane leaves a tombstone where it was, and its tab keeps the other pane', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.keyboard.press('Meta+d')
  await expect(
    window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
  ).toHaveCount(2)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  const ids = await paneIds(window)
  expect(ids).toHaveLength(2)
  const [left, right] = ids

  // The victim is named from the APP's own pane id and the slug `beforeEach`
  // seeded, never from whatever a session listing happened to return second —
  // `SessionManager` names a member session `prcli-<projectSlug>-<paneId>`
  // (see `tests/integration/pane-death.test.ts`'s `prcli-alpha-${founder.id}`).
  // Asserted to exist on THIS socket before its pid is looked up, so the
  // `kill` below cannot be aimed at anything this file did not create; see
  // `panePid` for the rest of the guard.
  const victim = `prcli-scratch-${right}`
  expect(await sessionNames(SOCKET)).toContain(victim)
  await run('kill', ['-9', await panePid(victim)])

  // The box stays where it was and the overlay draws over it. A pane that
  // vanished — or that reappeared at the end of the row — is the regression
  // this pins, so the ORDER is asserted, not just the count.
  //
  // What it pins EXACTLY, since the expected value is read off the screen
  // before the kill rather than written down here: the death did not move the
  // box. It is blind by construction to any reordering that does not depend on
  // deadness, because such a reordering moves the before-reading too. Measured
  // 2026-08-02, both halves: `boxesOfRow` walking `row.layout.kids` in reverse
  // leaves this GREEN (it reddens the ⌘D test's active-pane assertion instead),
  // while sorting tombstoned entries ahead of live ones fails exactly this line
  // with `[right, left]`. The second is the mutation this assertion answers;
  // the first is a different claim, and this line does not make it.
  await expect(window.getByTestId(`dead-${right}`)).toBeVisible({ timeout: 20_000 })
  expect(await paneIds(window)).toEqual([left, right])
  await expect(window.getByTestId(`pane-${left}`)).toBeVisible()

  // Restart brings a live session back under the same pane id. `toHaveCount(0)`
  // is a polling matcher and so is the poll below, but neither is a non-change
  // assertion: both wait for something the click MAKES happen — the tombstone
  // going and the second session coming back — so returning on the first match
  // is exactly right here.
  await window.getByTestId(`pane-restart-${right}`).click()
  await expect(window.getByTestId(`dead-${right}`)).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  // And the session that came back is the dead pane's own, under the same
  // name: two sessions could otherwise be the survivor plus something else.
  //
  // UNMEASURED, said rather than implied: it is not true by construction and
  // is worth keeping, but no mutation run against this file has failed it on
  // its own — unwiring `onRestart` reddens the poll above first and this line
  // is never reached. What would reach it is a restart that makes a session
  // under some other name, which nothing here forces.
  expect(await sessionNames(SOCKET)).toContain(victim)

  await app.close()
})

/**
 * The first test anywhere in this repo to press a pointer down on a divider.
 *
 * `tests/unit/dividers.test.ts` covers this gesture by reading `App.tsx` and
 * `PaneDivider.tsx` AS TEXT — vitest runs `environment: 'node'`, so it has no
 * DOM and no layout — and its own header lists what that cannot see. Three of
 * those items are here: that a pointerdown starts a drag and a pointerup ends
 * one, where the divider lands, and that a pane follows the cursor and reflows
 * tmux behind it.
 */
test('dragging the divider moves the seam, reflows tmux, and is written down on release', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  const [left, right] = await splitTabInto(window, 2)

  // Exactly one divider for two panes, and scoped to the ACTIVE group so a
  // hidden tab's overlay — which is `invisible` rather than unmounted, see
  // `App.tsx`'s note on why that class is load-bearing for input — cannot be
  // the one that is grabbed.
  const divider = window.getByTestId('terminal-active').getByTestId('pane-divider')
  await expect(divider).toHaveCount(1)

  const seamBefore = (await divider.boundingBox())!
  const leftBefore = await paneBox(window, left)
  const rightBefore = await paneBox(window, right)

  // WHERE the divider lands, asserted before it is touched. This is the only
  // line in the file that reads the strip's position rather than using it, and
  // without it the whole test survives a divider drawn at the tab's leading
  // edge: `PaneDivider` measures its travel from the clientX of the pointerdown
  // (`PaneDivider.tsx:81,92`), so a drag started on a MISPLACED strip still
  // reports the right delta and still moves the right pair. Every assertion
  // below it would pass. Measured 2026-08-02: both `App.tsx`'s `slice(0, index)`
  // becoming `slice(0, index - 1)` and `PaneDivider`'s `${offset * 100}%`
  // becoming a constant `0%` fail HERE and nowhere else in this file, and
  // `dividers.test.ts` stays 11/11 green under both.
  //
  // 6px, derived rather than guessed and then measured: `PaneDivider`'s own
  // comment bounds the seam error at `n − 1.5` pixels — half a pixel for the two
  // panes here. Measured 2026-08-02 on a 1280x800 window: exactly 0.5px, with
  // both panes at 423.5px. 6px is eleven times the measured value and two orders
  // of magnitude under the 423.5px error the two mutations below produce.
  const seamMiddle = seamBefore.x + seamBefore.width / 2
  expect(Math.abs(seamMiddle - (leftBefore.x + leftBefore.width))).toBeLessThan(6)

  const colsBefore = await windowCols(`prcli-scratch-${left}`)
  // Non-finite first: every `toBeGreaterThan` below is false against `NaN`, so a
  // reading that failed to parse would turn the reflow poll into a guaranteed
  // timeout wearing the costume of a failed assertion.
  expect(Number.isFinite(colsBefore)).toBe(true)

  await window.mouse.move(seamMiddle, seamBefore.y + seamBefore.height / 2)
  await window.mouse.down()

  // THREE moves, at equal cursor steps, and the reason is the whole shape of
  // this assertion. `PaneDivider` reports CUMULATIVE travel from the
  // pointerdown and `dragPane` applies it to the ratio captured at `onGrab`
  // (`App.tsx:244-311`), which makes width strictly LINEAR in cursor travel. An
  // implementation that applied each frame's cumulative delta to the ratio the
  // previous frame left behind compounds — and compounding OVERSHOOTS IN THE
  // SAME DIRECTION, so a lower bound like "wider than it was, by 80px" is
  // satisfied by the broken implementation as comfortably as by the correct
  // one. Equal steps producing equal gains is what the two disagree about.
  const step = 60
  const axis = seamBefore.y + seamBefore.height / 2
  await window.mouse.move(seamMiddle + step, axis)
  const w1 = await widthAfterFrame(window, left)
  await window.mouse.move(seamMiddle + step * 2, axis)
  const w2 = await widthAfterFrame(window, left)
  await window.mouse.move(seamMiddle + step * 3, axis)
  const w3 = await widthAfterFrame(window, left)

  // Read mid-gesture, before the release: the pane follows the cursor live,
  // which is the claim, rather than snapping into place on pointerup.
  expect(w1).toBeGreaterThan(leftBefore.width + 40)
  // And linearly. 12px against a 60px step — a fifth of it — was a guess and is
  // now measured: 2026-08-02 the three widths were 483.44 / 543.36 / 603.29, so
  // the two gains were 59.922 and 59.930 and the spread was 0.008px. The bound
  // is three orders of magnitude above the noise and an order of magnitude below
  // the ~46px spread a compounding implementation produces at this window size.
  expect(Math.abs((w3 - w2) - (w2 - w1))).toBeLessThan(12)

  // The pane on the other side of the seam gave up what this one took. On two
  // panes this is arithmetic restating itself — two shares that normalise to 1
  // cannot do anything else — so it is here to say the RIGHT pane is the one
  // that moved, and the three-pane test below is where conservation earns its
  // keep.
  const rightAfter = await paneBox(window, right)
  expect(rightAfter.width).toBeLessThan(rightBefore.width - 40)

  await window.mouse.up()

  // tmux reflows behind it, through `Terminal.tsx`'s existing ResizeObserver. A
  // wider box that never reached tmux is a pane drawing over a session still
  // 80 columns wide, which is the bug this catches.
  //
  // Measured 2026-08-02, because it rests on something this project had never
  // checked: the two panes of a split are two tmux SESSIONS IN ONE SESSION
  // GROUP, and grouped sessions share a window list. Attaching two clients at
  // 200 and 37 columns to a grouped pair on a scratch `prcli-e2e-probe` socket
  // — each member bound to its own window by index, exactly as
  // `SessionManager.splitTab` binds them — reported `#{window_width}` of 200
  // and 37, and after resizing the clients to 240 and 20 reported 240 and 20.
  // Each session reports ITS OWN window. There is no shared minimum, so this
  // poll means what it says.
  await expect
    .poll(async () => await windowCols(`prcli-scratch-${left}`), { timeout: 20_000 })
    .toBeGreaterThan(colsBefore)

  // And written down, on release, to the founder pane's tab row.
  //
  // Polled as a POSITIVE condition. `.not.toEqual([0.5, 0.5])` would be
  // satisfied on the first tick by a MISSING row — `savedRatio` returns
  // `undefined` when nothing matches `left`, and `undefined` is not equal to
  // `[0.5, 0.5]` — so a `left` naming the wrong pane, which is exactly what a
  // broken `paneIds` produces, would have passed instantly. `?.[0] ?? 0` keeps
  // the shape while making it something only a real, larger, written-down share
  // can satisfy.
  await expect
    .poll(async () => (await savedRatio(left))?.[0] ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0.5)

  // The one persistence assertion with teeth. Two others were drafted here and
  // are deliberately absent, because both are true by construction and can
  // discriminate nothing: `routeShares` builds `ratio` as `savedKids.map(...)`,
  // so its length IS the row's kid count whatever the drag sent, and it divides
  // each share by the saved kids' own total, so it sums to 1 the same way
  // (`src/main/ipc/shares.ts:267-273`).
  const saved = await savedRatio(left)
  expect(saved?.[0]).toBeGreaterThan(0.5)

  await app.close()
})

test('a drag stops at the floor, and the same gesture reversed reopens the pane', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  const [, right] = await splitTabInto(window, 2)

  const divider = window.getByTestId('terminal-active').getByTestId('pane-divider')
  await expect(divider).toHaveCount(1)
  const seam = (await divider.boundingBox())!
  const rightBefore = await paneBox(window, right)

  const axis = seam.y + seam.height / 2
  await window.mouse.move(seam.x + seam.width / 2, axis)
  await window.mouse.down()
  // Far past the right-hand pane's floor. `grabFor` derives that floor in CELLS
  // — `minRatioFor(MIN_PANE_COLS, gridCells / low.share)`, `workspace.ts:446` —
  // so it is not a pixel fraction this test can compute, and the gesture is
  // simply shoved most of the way across the tab instead.
  await window.mouse.move(seam.x + rightBefore.width * 2, axis)

  // Settled, then asserted PLAINLY. `expect.poll` returns on its first match
  // and so cannot assert that a pane stopped — it would pass on any frame
  // during which the pane was still on its way. This file has already measured
  // the cost of skipping that settle once: the refusal test above passed
  // against a build that split anyway until 1500ms was added before its
  // non-change assertions.
  //
  // `rightBefore.width / 2` rather than a pixel count, so the bound moves with
  // the window. Measured 2026-08-02: the pane started at 423.5px and pinned at
  // 162.88px against a bound of 211.75px — a floor of 0.192 of the axis, which
  // is `minRatioFor(20, cols/share)` for a pane reporting ~50 columns at half a
  // 1280px window. The margin is 49px, so this is a real inequality and not a
  // coincidence of one window size; it would only stop discriminating if the
  // floor rose past a quarter of the tab.
  await window.waitForTimeout(300)
  const pinned = await paneBox(window, right)
  expect(pinned.width).toBeGreaterThan(0)
  expect(pinned.width).toBeLessThan(rightBefore.width / 2)

  // Reversed WITHOUT releasing: the clamp is on the movement and not on the
  // result (`resizeKids`' own doc says so), so a pane held at its floor must
  // reopen the moment the gesture comes back past the point where the floor
  // bit. A poll is right here — this waits for something the move MAKES happen.
  await window.mouse.move(seam.x - rightBefore.width / 2, axis)
  await expect
    .poll(async () => (await paneBox(window, right)).width)
    .toBeGreaterThan(pinned.width + 40)
  await window.mouse.up()

  await app.close()
})

/**
 * Conservation: the pane nobody touched does not move.
 *
 * The only assertion in this file that can catch *the drag moved the right
 * direction on the wrong pair* — a pane nobody acted on changing width, which
 * is a defect this project has shipped. It needs three LIVE panes. On two,
 * "the left grew and the right shrank by the same amount" is arithmetic
 * restating itself, and there is no third pane to quantify over. And all three
 * must be live: the tombstone test below routes its third pane's share through
 * main's `owed` record, where simple conservation does not hold and an
 * assertion written as if it did would be false rather than strict.
 */
test('dragging one seam of a three-pane row leaves the far pane where it was', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  const [a, b, c] = await splitTabInto(window, 3)
  expect([a, b, c].every(Boolean)).toBe(true)

  const aBefore = await paneBox(window, a)
  const bBefore = await paneBox(window, b)
  const cBefore = await paneBox(window, c)

  // The FIRST seam, explicitly, and the count asserted before it is taken.
  // Grabbing "a divider" out of three panes without saying which is how a test
  // passes on the wrong gesture.
  const dividers = window.getByTestId('terminal-active').getByTestId('pane-divider')
  await expect(dividers).toHaveCount(2)
  const seam = (await dividers.first().boundingBox())!

  // LEFTWARD, and that is a measured choice rather than a stylistic one. Two
  // ⌘D presses leave the row at 0.5/0.25/0.25, so the middle pane has only the
  // distance from 0.25 down to its floor to give — under 70px on a 1280px
  // window — while the first pane has the whole way from 0.5 down to the same
  // floor, which is ~250px. Dragging right would run into the clamp before the
  // 12px conservation tolerance meant anything.
  const axis = seam.y + seam.height / 2
  await window.mouse.move(seam.x + seam.width / 2, axis)
  await window.mouse.down()
  await window.mouse.move(seam.x + seam.width / 2 - 160, axis)
  await window.mouse.up()

  const aAfter = await paneBox(window, a)
  const bAfter = await paneBox(window, b)
  const cAfter = await paneBox(window, c)

  // `a` shrank, `b` grew, and by the same amount.
  expect(aAfter.width).toBeLessThan(aBefore.width - 60)
  expect(bAfter.width).toBeGreaterThan(bBefore.width + 60)
  expect(Math.abs((aAfter.width - aBefore.width) + (bAfter.width - bBefore.width))).toBeLessThan(12)

  // And `c` did not move. THIS is the assertion the test exists for: a drag
  // that moved the wrong pair in the right direction satisfies every line above
  // it.
  //
  // Stated honestly rather than implied: on screen these two lines and the one
  // above them are the SAME claim wearing three faces. The three boxes fill a
  // container of fixed width, so their pixel widths sum to a constant and
  // `Δa + Δb + Δc = 0` exactly; `c`'s x is `a`'s width plus `b`'s plus the
  // hairlines, so its shift is `−Δc.width`. Any one of the three failing fails
  // the others. They are kept as three because they say three different things
  // to whoever reads the failure, not because they are three independent
  // checks — and the tolerance is what makes them assertions at all.
  //
  // 12px against a 160px drag was a guess and is now measured: 2026-08-02, from
  // 423 / 211.5 / 211.5, the drag moved `a` by −159.617 and `b` by +159.617 —
  // the two summing to 0 exactly — and left `c`'s width and x both changed by
  // exactly 0. The bound is twelve pixels of room over zero measured noise.
  expect(Math.abs(cAfter.width - cBefore.width)).toBeLessThan(12)
  expect(Math.abs(cAfter.x - cBefore.x)).toBeLessThan(12)

  await app.close()
})

/**
 * A drag on a tab that is holding a tombstone.
 *
 * Three panes so the tombstone is not the whole of one side of the only seam,
 * and — the reason that choice is forced rather than preferred — so main's
 * saved row has more than one kid left to have a proportion BETWEEN. Traced
 * before it was written, and confirmed on screen by the `toHaveCount(2)`
 * below: a tombstoned kid keeps its place in the renderer's row (`died` writes
 * `state.dead` and nothing else) and keeps its box (`boxesOfRow` boxes a dead
 * kid ratio and all), so `grabFor`'s `boxes.length !== row.layout.kids.length`
 * refusal does NOT fire and a two-pane row with one tombstone does present a
 * grabbable divider. Two panes were rejected anyway: main drops the dead pane's
 * kid, so a two-pane row leaves main's row naming exactly one pane, whose ratio
 * `routeShares` divides by its own total and writes as `[1]` before and after
 * any drag whatsoever. The persistence assertion would have been inert.
 */
test('a drag on a tab holding a tombstone is kept, and the tombstone keeps its new width', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  const [live, dead, far] = await splitTabInto(window, 3)

  // The victim is named from the APP's own pane id and the slug `beforeEach`
  // seeded, and asserted to exist on THIS socket before its pid is looked up.
  // See `panePid` for the rest of the guard; this is the same derivation the
  // tombstone test above uses and there is deliberately no second path to it.
  const victim = `prcli-scratch-${dead}`
  expect(await sessionNames(SOCKET)).toContain(victim)
  await run('kill', ['-9', await panePid(victim)])
  await expect(window.getByTestId(`dead-${dead}`)).toBeVisible({ timeout: 20_000 })
  expect(await paneIds(window)).toEqual([live, dead, far])

  // The trace, on screen: two dividers means three boxes for three kids, so the
  // tombstone did not cost the row its length and `grabFor` has a pair to take.
  const dividers = window.getByTestId('terminal-active').getByTestId('pane-divider')
  await expect(dividers).toHaveCount(2)

  // The precondition, asserted rather than assumed, and it is not the one a
  // first reading expects: the row ON DISK still names all three kids. A death
  // writes `config.panes` (`register.ts:359-361`) from the config it had
  // already read, and `normaliseLayout` drops a dead pane's kid only on the way
  // IN — so the file keeps the tombstone's entry until something rewrites the
  // row. In this test the only thing that ever does is the drag below, which is
  // what makes the length change downstream evidence that main took it.
  expect(await savedRatio(live)).toHaveLength(3)
  const seam = (await dividers.first().boundingBox())!
  const deadBefore = await paneBox(window, dead)

  // Leftward again, and here it is what gives the persistence assertion its
  // signal as well as its room. Main's row is the two LIVE kids, projected onto
  // their own total: growing the tombstone shrinks the live pair's first share
  // sharply, where shrinking the tombstone is capped by its floor within a few
  // hundredths.
  const axis = seam.y + seam.height / 2
  await window.mouse.move(seam.x + seam.width / 2, axis)
  await window.mouse.down()
  await window.mouse.move(seam.x + seam.width / 2 - 160, axis)
  await window.mouse.up()

  // Main kept it. Under the length guard `CHANNELS.setLayout` carried until
  // `5ba3abf` — `if (ratio.length !== saved.layout.kids.length) return` — every
  // drag on a tombstoned tab was silently discarded and this poll would time
  // out on a row still reading its pre-drag ratio. The channel now takes named
  // shares and routes membership by name (`register.ts:742`).
  //
  // Two kids, down from the three the file held a moment ago: the row main
  // wrote is `routeShares`' projection onto the panes it still has, and the
  // tombstone's share went to `owed` instead.
  await expect
    .poll(async () => (await savedRatio(live))?.length ?? 0, { timeout: 20_000 })
    .toBe(2)

  // The tombstone took the width the drag gave it.
  const deadDragged = await paneBox(window, dead)
  expect(deadDragged.width).toBeGreaterThan(deadBefore.width + 60)

  // And what main wrote is what is on screen, in main's own frame. Checked
  // against the two live boxes rather than against a constant, which makes it
  // window-size independent AND makes it fail on a drag that was discarded: the
  // pre-drag row projects to 0.5/(0.5+0.25) = 0.667, the dragged one to about
  // 0.55, and 12 pixels of drag either way moves this further than the
  // tolerance. 0.01 is a guess bounded by two real sources of error — `percent()`
  // rounds a share to four places, and the flex `gap-px` hairlines shrink the
  // panes in proportion to their bases, which preserves this ratio to about a
  // thousandth. Measured 2026-08-02: main wrote [0.5546218, 0.4453782] and the
  // boxes read 0.5546270, an error of 5.1e-6 against a bound of 0.01.
  const liveAfter = await paneBox(window, live)
  const farAfter = await paneBox(window, far)
  const onScreen = liveAfter.width / (liveAfter.width + farAfter.width)
  const written = await savedRatio(live)
  expect(written?.[0]).toBeDefined()
  expect(Math.abs((written?.[0] ?? 0) - onScreen)).toBeLessThan(0.01)

  // And keeps it across a restart. What this claims, exactly, and no more: a
  // restart does not reset the tab to an even split. It does NOT witness
  // `register.ts:756-758`'s `owed` write, and must not be read as doing so —
  // that write lands in main's private `tombstones` map, while the width on
  // screen here comes from the RENDERER's row, which `opened` leaves untouched
  // (`workspace.ts:958-975`) and which `withKeptPanes` re-anchors a tombstone
  // from in every later rebuild (`workspace.ts:759-796`). Measured 2026-08-02,
  // with that `for (const entry of routed.owed)` loop deleted: this file stayed
  // green. See this file's non-coverage header for where the `owed` write IS
  // witnessed.
  await window.getByTestId(`pane-restart-${dead}`).click()
  await expect(window.getByTestId(`dead-${dead}`)).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(3)
  const revived = await paneBox(window, dead)
  // 12px, and measured 2026-08-02 at exactly 0 — the pane came back at
  // 371.117px, the width the drag left it at, against 211.5px for the even
  // third a reset row would have given it. The bound would still discriminate
  // at ten times its size.
  expect(Math.abs(revived.width - deadDragged.width)).toBeLessThan(12)
  expect(await paneIds(window)).toEqual([live, dead, far])

  await app.close()
})
