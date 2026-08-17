/**
 * Wall mode driven end to end: several projects' terminals side by side in the
 * one column, each cell showing that project's pinned pane.
 *
 * Everything under the wall is unit-tested somewhere: `cellRect`'s arithmetic,
 * `slotsFromStored`'s degradation, `visibleGroupIds`' filled-slot rule,
 * `withWallPin`'s owner resolution. None of those tests has a pty, a layout
 * engine or a renderer in it, and the questions this file exists for are
 * exactly the ones they cannot ask: whether three real terminals end up in
 * three boxes that do not sit on top of each other, whether a keystroke lands
 * in the cell that was clicked and in no other, whether the config half and the
 * `localStorage` half still agree after the app has been shut down and started
 * again, and how many of the panes a wall puts on screen at once can still hold
 * a WebGL context.
 *
 * Seven tests. The first six drive the feature; the seventh is a MEASUREMENT
 * (see its own comment), and its number is the answer the plan wanted, not a
 * threshold to tune until it is green.
 *
 * How a test gets into the wall: `enterWall` writes the three `localStorage`
 * keys `useWallState` reads and reloads. That is the same route the View menu
 * item and the palette command take once the window is up, minus the click. The
 * hook reads those keys at mount and nowhere else, so a reload is what a test
 * needs to seed them. Pinning goes the other way, through the palette's
 * real "Pin this pane to the wall" command, and `pinsLanded` then waits on the
 * written `config.json` rather than on a timer, because `setWallPin` is fire
 * and forget and a reload racing it would read a config with no pins in it.
 *
 * **What this file does NOT see**, read off its own text unless a line says
 * measured:
 *
 * - **the View menu and the sidebar routes.** The `toggle-wall` item, the
 *   `Wall columns` submenu and the sidebar row's `pwall-` entry are Task 8's
 *   and are not clicked here; Electron's application menu is not reachable from
 *   Playwright at all. The palette's two commands ARE exercised, since this file
 *   pins and toggles through them.
 * - **follow-active.** No test here turns `wallFollowActive` on, so the branch
 *   of `wallPinFor` that resolves a cell from `activeTabId` (and its refusal to
 *   fall back to the pin when that is null) is unwitnessed by this file.
 * - **what a cell DRAWS.** Every assertion here is about boxes, ids and text.
 *   That a 550px-wide terminal is legible, that the header does not clip its
 *   project name, and that the focus outline is visible are pictures nothing
 *   automated re-checks.
 * - **the glyphs behind test 7.** The renderer a pane got is the closest thing
 *   to a test; that a DOM-renderer pane draws Claude Code's block characters as
 *   slivers was established by looking at screenshots. See `webgl.spec.ts`'s
 *   header for that, and for the measured Chromium cap of 16 the budget sits
 *   under.
 * - **more than four cells, and columns other than 2.** `WALL_COLUMNS_MAX` is
 *   4 and every test here runs at two columns, so the stretched last row is
 *   witnessed (three cells at two columns is two then one, full width) but a
 *   3-wide or 4-wide grid is not.
 * - **the picker.** `wall-picker-` is never opened. Pinning here goes through
 *   the palette, so the picker's rows, its unpin toggle and its outside-click
 *   dismissal are `WallCell`'s own business and untested by this file.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expandColumn, killServer, launchApp, sessionNames, terminalTextOf } from './harness'
import { WEBGL_PANE_BUDGET_DEFAULT } from '../../src/renderer/lib/webglBudget'

const run = promisify(execFile)

const SOCKET = 'pterm-e2e-wall'

let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

const launch = (): Promise<ElectronApplication> =>
  launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-wall-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-wall-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-wall-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-wall-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  await writeFile(claudeSettingsPath, '{}', 'utf8')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-wall-claude-'))
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * `count` projects, each a real repository on a branch named after it.
 *
 * Real `git init` rather than a hand-built `.git` holding only `HEAD`, which is
 * all `gitbranch.spec.ts` needs: the Git COLUMN shells out to `git status`, and
 * test 3 uses both it and the status bar to say that a project-scoped column
 * follows wall focus. An empty repository is enough for either: `git status`
 * reports `# branch.head` before the first commit.
 *
 * **`wallPin` and `wallFollowActive` are deliberately absent** from the rows
 * written here even though the version is 10 and `ProjectRecord` requires them.
 * `store.ts` normalises both on read, and a seed that carried them would be
 * asserting the shape this suite wrote rather than the shape the app repairs.
 */
async function seedProjects(count: number): Promise<void> {
  const projects = []
  for (let n = 1; n <= count; n++) {
    const cwd = join(projectsRoot, `p${n}`)
    await mkdir(cwd, { recursive: true })
    await run('git', ['-c', `init.defaultBranch=wall-${n}`, 'init', '-q'], { cwd })
    projects.push({
      id: `id-${n}`,
      name: `P${n}`,
      slug: `p${n}`,
      cwd,
      presets: [],
      activeTabId: null,
    })
  }
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({ version: 10, projects, activeProjectId: 'id-1', tabs: [] }),
    'utf8',
  )
}

/**
 * Open one terminal in `projectId` and answer its pane id.
 *
 * The bar lists only the active project's panes, so the project is clicked
 * first and the count is read after that click rather than before it.
 */
async function openPaneIn(window: Page, projectId: string): Promise<string> {
  await window.getByTestId(`project-${projectId}`).click()
  const tabs = window.locator('[data-testid^="tab-"]')
  const before = await tabs.count()
  await window.getByTestId('new-tab').click()
  await expect(tabs).toHaveCount(before + 1)
  const testId = await tabs.last().getAttribute('data-testid')
  const id = (testId ?? '').replace('tab-', '')
  expect(id).not.toBe('')
  return id
}

/** Pin the active project's active pane, through the palette command. */
async function pinActive(window: Page): Promise<void> {
  await window.keyboard.press('Meta+k')
  await expect(window.getByTestId('command-palette')).toBeVisible()
  // A query is required: `CommandPalette` shows sessions only for an empty one.
  await window.getByTestId('palette-input').fill('Pin this pane')
  await window.getByTestId('palette-command-Pin this pane to the wall').click()
  await expect(window.getByTestId('command-palette')).toHaveCount(0)
}

/** Turn the wall off through the palette, the same way `pinActive` pins. */
async function leaveWall(window: Page): Promise<void> {
  await window.keyboard.press('Meta+k')
  await expect(window.getByTestId('command-palette')).toBeVisible()
  await window.getByTestId('palette-input').fill('Turn the wall off')
  await window.getByTestId('palette-command-Turn the wall off').click()
  await expect(window.getByTestId('command-palette')).toHaveCount(0)
}

/** Every project's `wallPin` as the written config currently has it. */
async function storedPins(): Promise<Record<string, string | null>> {
  const raw = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')) as {
    projects: { id: string; wallPin?: string | null }[]
  }
  return Object.fromEntries(raw.projects.map((project) => [project.id, project.wallPin ?? null]))
}

/**
 * Wait until `config.json` carries exactly these pins.
 *
 * `setWallPin` is `ipcMain.on` behind a serialised read-modify-write, so the
 * renderer knows nothing about when it lands. A reload that beat it would come
 * up on an empty wall, and the failure would read as a broken wall rather than
 * as a race. Polling the file is also the only direct look this suite gets at
 * the half of persistence that is NOT `localStorage`.
 */
async function pinsLanded(pins: Record<string, string>): Promise<void> {
  await expect
    .poll(
      async () => {
        const stored = await storedPins()
        return Object.fromEntries(Object.keys(pins).map((id) => [id, stored[id] ?? null]))
      },
      { timeout: 20_000 },
    )
    .toEqual(pins)
}

/**
 * The pane `projectId` ended up pinned to, once the write has landed.
 *
 * Test 7 pins a pane of a SPLIT tab and has no other way to learn which one:
 * the bar lists both panes of the tab, and nothing on screen says which of them
 * `pinActivePane` named. Polled rather than read once, for the same race
 * `pinsLanded` exists for.
 */
async function pinLanded(projectId: string): Promise<string> {
  await expect
    .poll(async () => typeof (await storedPins())[projectId] === 'string', { timeout: 20_000 })
    .toBe(true)
  return (await storedPins())[projectId] as string
}

/** Turn the wall on over `slots`, at `columns`, and reload into it. */
async function enterWall(window: Page, slots: string[], columns: number): Promise<void> {
  await window.evaluate(
    ({ slots: ids, columns: count }) => {
      localStorage.setItem('pterm:wall', '1')
      localStorage.setItem('pterm:wallSlots', JSON.stringify(ids))
      localStorage.setItem('pterm:wallColumns', String(count))
    },
    { slots, columns },
  )
  await window.reload()
  await expect(window.locator('[data-testid^="wall-cell-"]')).toHaveCount(slots.length, {
    timeout: 30_000,
  })
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Every VISIBLE pane group: which panes are in it, and the box it occupies.
 *
 * Rounded to whole pixels so a box read before a relaunch can be compared with
 * one read after it: a cell's rect is a percentage string, and the sub-pixel
 * tail of `50%` of a column width is not a number two runs have to agree on.
 *
 * `:scope >` and the `pane-divider` filter for the reason `webgl.spec.ts`
 * gives: the `pane-` prefix also names the divider strips and the per-pane dot,
 * restart and dismiss controls.
 */
async function visibleGroups(window: Page): Promise<{ panes: string[]; box: Box }[]> {
  return window.evaluate(() =>
    [...document.querySelectorAll('[data-testid="terminal-active"]')].map((group) => {
      const rect = group.getBoundingClientRect()
      return {
        panes: [...group.querySelectorAll(':scope > [data-testid^="pane-"]')]
          .map((pane) => pane.getAttribute('data-testid') ?? '')
          .filter((id) => id !== 'pane-divider')
          .map((id) => id.slice('pane-'.length)),
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }
    }),
  )
}

/** Every group, keyed by the panes in it, so two reads can be compared unordered. */
function byPanes(groups: { panes: string[]; box: Box }[]): Record<string, Box> {
  return Object.fromEntries(groups.map((group) => [group.panes.join('+'), group.box]))
}

function overlap(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

/** The renderer each mounted pane is on, exactly as `webgl.spec.ts` reads it. */
async function renderersOf(window: Page): Promise<Record<string, string>> {
  return window.evaluate(
    () =>
      (globalThis as unknown as { __ptermRenderers?: () => Record<string, string> })
        .__ptermRenderers?.() ?? {},
  )
}

/**
 * `count` projects, one terminal each, all pinned, wall on at two columns.
 *
 * The shape the first six tests share. Answers the pane ids in project order,
 * which is what every assertion about "the second cell" is written against.
 */
async function wallOfOnePaneEach(window: Page, count: number): Promise<string[]> {
  const panes: string[] = []
  for (let n = 1; n <= count; n++) {
    const pane = await openPaneIn(window, `id-${n}`)
    await expect
      .poll(async () => (await sessionNames(SOCKET)).length, { timeout: 30_000 })
      .toBe(n)
    await pinActive(window)
    panes.push(pane)
  }
  await pinsLanded(Object.fromEntries(panes.map((pane, index) => [`id-${index + 1}`, pane])))
  await enterWall(
    window,
    panes.map((_, index) => `id-${index + 1}`),
    2,
  )
  await expect(window.locator('[data-testid="terminal-active"]')).toHaveCount(count, {
    timeout: 30_000,
  })
  return panes
}

/*
 * The whole claim of the feature in one assertion: three projects, three
 * terminals, three boxes at once. Before wall mode the terminal column drew
 * exactly one group, so a regression that lost the multiple-visible-groups
 * change (`visibleGroupIds`, Task 3) shows up here as a count of one, and one
 * that lost the rect (Task 1, Task 7) shows up as three boxes stacked on the
 * same `inset-0`, which is what the overlap check is for and why the count on
 * its own does not settle it.
 */
test('three projects, three pinned panes, three live cells', async () => {
  test.setTimeout(150_000)
  await seedProjects(3)
  const app = await launch()
  const window = await app.firstWindow()

  const panes = await wallOfOnePaneEach(window, 3)

  const groups = await visibleGroups(window)
  expect(groups).toHaveLength(3)
  expect(groups.flatMap((group) => group.panes).sort()).toEqual([...panes].sort())

  for (const group of groups) {
    expect(group.box.width).toBeGreaterThan(0)
    expect(group.box.height).toBeGreaterThan(0)
  }
  for (let a = 0; a < groups.length; a++) {
    for (let b = a + 1; b < groups.length; b++) {
      expect(`${a}/${b}: ${overlap(groups[a].box, groups[b].box)}`).toBe(`${a}/${b}: false`)
    }
  }

  // Three slots at two columns is two cells then one, and the last row
  // stretches: `cellRect`'s remainder rule, seen on real boxes rather than in
  // its own unit test's percentage strings.
  const rows = [...new Set(groups.map((group) => group.box.y))].sort((x, y) => x - y)
  expect(rows).toHaveLength(2)
  const bottom = groups.filter((group) => group.box.y === rows[1])
  expect(bottom).toHaveLength(1)
  expect(bottom[0].box.width).toBeGreaterThan(groups[0].box.width)

  // Every slot is filled, so no placeholder is drawn anywhere.
  await expect(window.locator('[data-testid^="wall-empty-"]')).toHaveCount(0)

  await app.close()
})

/*
 * Three live terminals share one keyboard, and nothing in the DOM says which
 * one has it: every group carries `terminal-active` now. If `choosePane` ever
 * stopped selecting the clicked pane, or if the wall's own project switch moved
 * the keyboard to the newly active project's active TAB instead of the pane
 * under the cursor, the marker would land in a neighbour, and the two negative
 * assertions are the half that catches that.
 */
test('typing goes to the cell that was clicked, and to no other', async () => {
  test.setTimeout(150_000)
  await seedProjects(3)
  const app = await launch()
  const window = await app.firstWindow()

  const panes = await wallOfOnePaneEach(window, 3)

  await window.getByTestId(`pane-${panes[1]}`).click()
  await window.keyboard.type('echo wall-second-cell')
  await window.keyboard.press('Enter')

  await expect
    .poll(async () => terminalTextOf(window, panes[1]), { timeout: 30_000 })
    .toContain('wall-second-cell')
  expect(await terminalTextOf(window, panes[0])).not.toContain('wall-second-cell')
  expect(await terminalTextOf(window, panes[2])).not.toContain('wall-second-cell')

  await app.close()
})

/*
 * "Wall focus IS the active project" is the design decision the whole feature
 * rests on: no second focus concept, so every project-scoped column follows a
 * cell without knowing the wall exists. This is that claim, driven from the
 * keyboard: ⌘2 is the pre-existing project switch, unchanged by wall mode, and
 * both a column (Git) and the status bar have to move with it.
 */
test('⌘2 focuses the second project\'s cell and the columns follow', async () => {
  test.setTimeout(150_000)
  await seedProjects(3)
  const app = await launch()
  const window = await app.firstWindow()

  await wallOfOnePaneEach(window, 3)
  await expandColumn(window, 'git')

  // The third project, because `wallOfOnePaneEach` opened them in order and
  // the last one it clicked is the one the config came back on. Asserted rather
  // than assumed so that what ⌘2 does below is a change and not a coincidence.
  await expect(window.getByTestId('wall-cell-id-3')).toHaveAttribute('data-focused', 'true')
  await expect(window.getByTestId('git-branch')).toHaveText('wall-3', { timeout: 20_000 })

  await window.keyboard.press('Meta+Digit2')

  await expect(window.getByTestId('wall-cell-id-2')).toHaveAttribute('data-focused', 'true')
  await expect(window.getByTestId('wall-cell-id-1')).toHaveAttribute('data-focused', 'false')
  await expect(window.getByTestId('wall-cell-id-3')).toHaveAttribute('data-focused', 'false')
  await expect(window.getByTestId('git-branch')).toHaveText('wall-2', { timeout: 20_000 })
  await expect(window.getByTestId('gitpanel-branch')).toHaveText('wall-2', { timeout: 20_000 })

  await app.close()
})

/*
 * Leaving the wall has to leave the user where they were looking, which is the
 * one piece of state the two modes share. The tab bar's return is the other
 * half: `showsTabBar` refuses it outright while the wall is on, so a toggle
 * that changed the groups but not the bar would leave a window with no way to
 * reach any tab but the active one.
 */
test('toggling the wall off lands on the focused cell\'s project', async () => {
  test.setTimeout(150_000)
  await seedProjects(3)
  const app = await launch()
  const window = await app.firstWindow()

  const panes = await wallOfOnePaneEach(window, 3)

  // The FIRST cell, which is not the one the wall came up on: the wall restores
  // onto the project the config was last left on, which is the third. Focusing
  // a different one is what makes the assertion after the toggle mean anything.
  //
  // The header, not the pane: `focusWallCell` is its own route, and it selects
  // the cell's PINNED pane rather than the project's active tab. The text span
  // rather than the box around it, which is `pointer-events-none`. `exact`
  // because the pane label beside it reads `p1 · <id>`, and a loose match takes
  // both.
  await expect(window.getByTestId('wall-cell-id-3')).toHaveAttribute('data-focused', 'true')
  await window.getByTestId('wall-cell-id-1').getByText('P1', { exact: true }).click()
  await expect(window.getByTestId('wall-cell-id-1')).toHaveAttribute('data-focused', 'true')

  await leaveWall(window)

  await expect(window.locator('[data-testid^="wall-cell-"]')).toHaveCount(0)
  await expect(window.getByTestId('project-id-1')).toHaveAttribute('data-active', 'true')
  // The bar is back, showing the first project's tabs and only those.
  await expect(window.getByTestId(`tab-${panes[0]}`)).toBeVisible()
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect(window.locator('[data-testid="terminal-active"]')).toHaveCount(1)

  await app.close()
})

/*
 * The reason an empty slot keeps its box.
 *
 * A pinned session dying must not resize the cells beside it: those are live
 * terminals whose tmux sessions would refit, and Claude Code answers a refit by
 * rewrapping its whole scrollback. So the surviving boxes are read before and
 * after and compared exactly.
 *
 * **The brief for this task describes one step where the app takes two**, and
 * the difference is real rather than cosmetic. Killing the session from outside
 * does NOT empty the cell: the pane lingers as a dead one, keeping its box and
 * its scrollback so Restart and Dismiss have something to act on
 * (`status.spec.ts`'s `a dead tab lingers, then restarts`, and `workspace.ts`'s
 * `died` case, which never drops a pane). The empty cell is what the DISMISS
 * produces, once the pane is gone and the project's `wallPin` still names it.
 * Both halves are asserted here, in that order.
 */
test('a pinned session that dies keeps its cell, and dismissing it draws an empty one', async () => {
  test.setTimeout(150_000)
  await seedProjects(3)
  const app = await launch()
  const window = await app.firstWindow()

  const panes = await wallOfOnePaneEach(window, 3)
  const before = byPanes(await visibleGroups(window))

  // Exactly what a crash outside the app leaves behind, the same way
  // `status.spec.ts` produces one.
  await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=pterm-p2-${panes[1]}`])

  await expect(window.getByTestId(`dead-${panes[1]}`)).toBeVisible({ timeout: 30_000 })
  // Still three cells, still three groups: the dead pane holds its own.
  await expect(window.locator('[data-testid="terminal-active"]')).toHaveCount(3)
  await expect(window.locator('[data-testid^="wall-empty-"]')).toHaveCount(0)
  expect(byPanes(await visibleGroups(window))).toEqual(before)

  await window.getByTestId(`pane-dismiss-${panes[1]}`).click()

  // Now the slot is empty, and it says which of the two empty states it is in:
  // the project still carries a pin, and the pin names a pane that is gone.
  await expect(window.getByTestId('wall-empty-id-2')).toBeVisible()
  await expect(window.getByTestId('wall-empty-id-2')).toHaveText('the pinned pane is gone')
  // The cell is still drawn, so the wall is still three slots wide.
  await expect(window.locator('[data-testid^="wall-cell-"]')).toHaveCount(3)
  await expect(window.locator('[data-testid="terminal-active"]')).toHaveCount(2)

  // And the two survivors are exactly where they were, to the pixel.
  const after = byPanes(await visibleGroups(window))
  expect(after).toEqual({
    [panes[0]]: before[panes[0]],
    [panes[2]]: before[panes[2]],
  })

  await app.close()
})

/*
 * Membership and column count live in `localStorage`; which pane a project
 * shows lives in `ProjectRecord.wallPin` in the config. Nothing writes both at
 * once, and nothing checks they agree. A relaunch is where a disagreement would
 * surface: the wall would come up with the right number of cells and the wrong
 * panes in them, or with cells whose pins had been forgotten. Comparing the
 * whole pane-to-box map is what makes that a failure rather than a shrug.
 */
test('the wall survives a relaunch, same cells and same panes', async () => {
  test.setTimeout(180_000)
  await seedProjects(3)
  const first = await launch()
  const firstWindow = await first.firstWindow()

  const panes = await wallOfOnePaneEach(firstWindow, 3)
  const before = byPanes(await visibleGroups(firstWindow))
  expect(Object.keys(before).sort()).toEqual([...panes].sort())
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()

  // No `enterWall` here: that is the point. The window has to come up on the
  // wall from what the previous one stored, with no test writing anything.
  await expect(secondWindow.locator('[data-testid^="wall-cell-"]')).toHaveCount(3, {
    timeout: 30_000,
  })
  await expect(secondWindow.locator('[data-testid="terminal-active"]')).toHaveCount(3, {
    timeout: 30_000,
  })
  await expect(secondWindow.locator('[data-testid^="wall-empty-"]')).toHaveCount(0)
  expect(byPanes(await visibleGroups(secondWindow))).toEqual(before)

  await second.close()
})

/*
 * A MEASUREMENT, and the one this plan's spec named as its open risk.
 *
 * Wall mode takes the on-screen pane count from one to several, and every pane
 * on screen wants a WebGL context. `claimRenderer` budgets those at
 * `WEBGL_PANE_BUDGET_DEFAULT` because Chromium caps live contexts per renderer
 * process at 16 (measured; see `webgl.spec.ts`'s header) and takes one back by
 * its own least-recently-DRAWN order when asked past that, which means from a
 * pane somebody is reading: an idle Claude Code session draws nothing. A pane
 * past the budget falls to the DOM renderer, where Claude Code's block
 * characters draw as slivers.
 *
 * Four projects at two columns, each cell holding a SPLIT tab, is the densest
 * arrangement the plan's ceiling of four columns allows a modest window: eight
 * panes on screen at once, against a budget of twelve.
 *
 * The assertion is against the budget rather than against a number typed here:
 * every pane on screen holds a context while the on-screen count is under the
 * budget, and that is the property, not the eight. If this ever goes red
 * because panes fell to the DOM renderer, the count is the finding, the thing
 * that decides whether four columns is the right ceiling, and not a threshold
 * to relax.
 */
test('every pane of a 2x2 wall of splits keeps a WebGL renderer', async () => {
  test.setTimeout(240_000)
  await seedProjects(4)
  const app = await launch()
  const window = await app.firstWindow()

  const panes: string[] = []
  let sessions = 0
  for (let n = 1; n <= 4; n++) {
    await openPaneIn(window, `id-${n}`)
    sessions += 1
    await expect
      .poll(async () => (await sessionNames(SOCKET)).length, { timeout: 30_000 })
      .toBe(sessions)
    // Split before pinning, so the pin names the pane the split created and the
    // cell shows a tab with two panes in it. The split is made while the wall
    // is still off and the column is full width, which is what keeps it clear
    // of `App.tsx`'s 20-column refusal.
    await window.keyboard.press('Meta+d')
    sessions += 1
    await expect
      .poll(async () => (await sessionNames(SOCKET)).length, { timeout: 30_000 })
      .toBe(sessions)
    await pinActive(window)
    panes.push(await pinLanded(`id-${n}`))
  }

  await enterWall(window, ['id-1', 'id-2', 'id-3', 'id-4'], 2)
  await expect(window.locator('[data-testid="terminal-active"]')).toHaveCount(4, {
    timeout: 60_000,
  })

  const groups = await visibleGroups(window)
  const onScreen = groups.flatMap((group) => group.panes)
  expect(groups.map((group) => group.panes.length)).toEqual([2, 2, 2, 2])
  expect(onScreen).toHaveLength(8)
  // A pin names ONE pane and its cell shows that pane's whole tab, so all four
  // pinned panes have to be among the eight. Without this the count of eight
  // would be satisfied by four cells showing the wrong splits.
  for (const pane of panes) expect(onScreen).toContain(pane)

  // Every pane has mounted and recorded a renderer before anything is counted.
  // A poll on the map's size rather than a sleep: a pane that has not claimed
  // yet is simply absent from `__ptermRenderers`.
  await expect
    .poll(async () => Object.keys(await renderersOf(window)).length, { timeout: 60_000 })
    .toBe(8)

  const renderers = await renderersOf(window)
  const webgl = onScreen.filter((pane) => renderers[pane] === 'webgl')
  // Named panes, not a count: which panes went without is the finding if any
  // did, and a count alone cannot say.
  expect(onScreen.map((pane) => `${pane}: ${renderers[pane]}`)).toEqual(
    onScreen.map((pane) => `${pane}: webgl`),
  )
  expect(webgl.length).toBe(Math.min(onScreen.length, WEBGL_PANE_BUDGET_DEFAULT))

  await app.close()
})
