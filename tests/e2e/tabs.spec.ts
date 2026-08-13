/**
 * Tabs, and the tmux sessions behind them, across every way a window can come
 * and go.
 *
 * Fifteen tests on the `pterm-e2e-tabs` socket: a second instance exits
 * rather than opening its own session; several tabs each keep their own
 * scrollback; a relaunch restores every tab and the one that was active; a
 * restored background tab keeps its tmux window size instead of settling to
 * 80×24; a relaunch lands on the tab that closing another one activated, and
 * the saved `activeTabId` agrees; a session the app never opened is adopted;
 * a renderer reload reattaches what is open without stranding or
 * duplicating; a `⌃b d` detach from inside a pane leaves the tab and its
 * session alone; ⌘T, ⌥⌘1 and ⌘W drive the renderer's own handler; the File
 * and View menu items do what their accelerators do; a close button destroys
 * exactly that session; a renamed tab shows the name in the bar and the
 * sidebar and it survives a relaunch, and a blank name clears it back to
 * slug and id in both places; and the context menu's Rename… item is the
 * topmost element at its own centre and reaches the same input the
 * double-click does; the ⌘K palette names a renamed tab the way the bar does;
 * and the tab's context menu recolours its pane from the same swatch row the
 * pane's own menu shows.
 *
 * **Measured, 2026-08-02, this file run alone** (`npx playwright test
 * tests/e2e/tabs.spec.ts`): changing `event.code === 'KeyW'` to `'KeyQ'` in
 * `App.tsx`'s window keydown handler fails one test here — `the keyboard
 * opens, switches and closes tabs` — and the other ten pass. 1 failed, 10
 * passed, reproduced on a second independent run. Ten tests passing under it
 * is the point of recording it: the blast radius inside this file is one
 * test, so a failure of that test names the ⌘W binding rather than saying the
 * app broke.
 *
 * **One test in THIS FILE, not one in the suite.** Measured separately the
 * same day: the same `KeyW`→`KeyQ` edit also fails `projects.spec.ts`'s
 * `a shortcut typed into the rename field does not reach the tab handler`,
 * which presses ⌘W with a terminal focused. Suite-wide that mutation is two
 * failures, not one.
 *
 * **Measured, 2026-08-03, this file run alone**: two mutations, one per
 * surface the rename had to reach then. Only one of them still has a surface
 * here, and the record is kept in full because which half died matters.
 *
 * The dead one reverted `Sidebar.tsx`'s `{tabLabel(tab)}` to an inlined
 * `{tab.projectSlug} · {tab.id.slice(0, 6)}` copy, and failed the rename test
 * below at `await expect(window.getByTestId('stab-${id}')).toContainText(
 * 'payments api')` and only there, the `tab-` assertion above it still
 * passing. That assertion is gone: the sidebar no longer lists a normal
 * project's panes at all, since the tab bar and the Tabs column both already
 * do. So nothing in this file covers `Sidebar.tsx` any more, and the shared
 * `tabLabel` selector is held on the sidebar side only by the `stab-`
 * assertions that Unsorted still has (`editor.spec.ts`, `projects.spec.ts`).
 *
 * The live one drops the `store.write` call from `renameTab`'s handler in
 * `register.ts`, and fails `a renamed tab shows its name in the bar and
 * survives a relaunch` at the assertion `await
 * expect(reopened.getByTestId('tab-${id}')).toContainText('payments api')`,
 * the one after the relaunch, not at the assertion before the close: the name
 * reached the bar live and only failed to come back, which is what a
 * reply-only rename with nothing written to disk would do. 1 failed, 12
 * passed of the thirteen tests this file held that day. Restoring the file
 * returned this file to green with an empty `git diff` against the committed
 * version.
 *
 * **Measured, 2026-08-04, this file run alone**: two mutations against the
 * palette test, one per half of its claim. Building the palette's label inline
 * in `App.tsx` — `name: ${pane.projectSlug} · ${pane.id.slice(0, 6)}` in place
 * of `name: tabLabel(pane)` — fails `the palette names a renamed tab the way
 * the bar does` at `await expect(row).toContainText('payments api')`, with the
 * row reading `scratch · d9a378`, which is the drift a shared selector exists
 * to prevent. Making `tabLabel` append rather than replace — returning
 * `${tab.title} (${tab.projectSlug} · ${tab.id.slice(0, 6)})` for a named tab
 * — clears that assertion and fails the next one,
 * `await expect(row).not.toContainText(id.slice(0, 6))`, on
 * `payments api (scratch · 6b5ee3)`. So neither assertion is carrying the
 * other: the positive one names the title, the negative one is what makes the
 * title a replacement.
 *
 * **What this file does NOT see** — read off this file's own text unless a
 * line says measured or names another file:
 *
 * - **anything past one pane in one tab.** Nothing here presses ⌘D and the
 *   seeded config's `tabs` is always `[]`, so every tab has exactly one pane
 *   and every group renders exactly one box, whose share renormalises to 1.
 *   `PaneDivider` is constructed only for `index > 0`
 *   (`src/renderer/App.tsx:860-861`, read 2026-08-04), so not one is ever
 *   constructed and the dividers overlay renders with no strips in it. A tab
 *   here is a pane wearing a tab's name, and the split behaviour the tab bar
 *   is shared with is invisible to this file. Stated as what renders rather
 *   than as which branch runs: an earlier version of this line said
 *   `boxesOfRow` is never reached, and it is — restore builds one tab row per
 *   live pane, adopted sessions included, so every pane a relaunch or an
 *   adoption brings back has a row (only a pane opened with `+` during a
 *   launch is rowless, and only until the next one). Measured in
 *   `launch.spec.ts` (2026-08-02, `boxesOfRow` mutated to throw: 2 failed, 2
 *   passed). Reaching it is not coverage of it, which is the point of this
 *   line — it is only ever reached with a single kid;
 * - `DeadPane`. No test here kills a session behind the app's back — the
 *   detach test kills a *client*, not a session — and no test in this file
 *   asserts on `dead-`, `pane-dot-`, `pane-restart-` or `pane-dismiss-` at
 *   all. Measured in `status.spec.ts`, which does kill one: making `DeadPane`
 *   render `null` left it 10 of 10 green. `splits.spec.ts` is where the
 *   overlay is actually witnessed — it kills one pane of a split and reddens
 *   under that mutation — so the claim above is this file's, not the suite's;
 * - **the OS accelerator layer.** ⌘T/⌘W/⌥⌘1 are dispatched into the window by
 *   Playwright and the menu items are clicked from inside the main process
 *   (see `clickMenuItem`). That nothing between the physical keyboard and the
 *   `window` listener eats a keystroke, and that macOS draws the menu at all,
 *   are both outside this file;
 * - **status dots, hooks and the dock badge** — `status.spec.ts`. No test here
 *   injects a hook event or reads a `dot-` testid, so a tab's colour is never
 *   asserted on;
 * - **more than one project.** One project is seeded and it stays selected;
 *   the sidebar, ⌘1–9 project switching, rename and remove are
 *   `projects.spec.ts`'s;
 * - **what a pane's shell printed**, beyond marker strings echoed into it.
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames, activeTerminalText } from './harness'

const run = promisify(execFile)
const SOCKET = 'pterm-e2e-tabs'

/**
 * The active tab in the tab bar.
 *
 * Scoped to `tab-` deliberately. The sidebar's project rows carry `data-active`
 * too, so a bare `[data-active="true"]` matches the selected project as well as
 * the selected tab and Playwright refuses it as ambiguous. What is asserted
 * about it is unchanged — only which element is being asked.
 */
const ACTIVE_TAB = '[data-testid^="tab-"][data-active="true"]'

let userDataDir: string
let configDir: string
let projectsRoot: string
let projectCwd: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

// Every launch in this file goes through the shared harness, so all five
// overrides are set by construction rather than by four copies of one env
// block that could drift apart — which is how three of the four specs came to
// be missing PTERM_CLAUDE_SETTINGS.
const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir })

/**
 * Write a config holding one project, selected.
 *
 * The app no longer opens a terminal on its own: a project has to exist for
 * `+` to have anywhere to open one. Driving the UI to add it is not possible
 * here — `choose-folder` opens a native dialog Playwright cannot touch — so
 * the config file is seeded directly. Returns the project's directory.
 */
async function seedProject(slug: string, name: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `pterm-proj-${slug}-`))
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

/** What tmux itself thinks the session's window measures. */
async function windowSize(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}',
  ])
  return stdout.trim()
}

/**
 * The seeded project's saved active tab. v3 records this once per project
 * rather than once for the workspace, so it is read off the project row —
 * a top-level `activeTabId` no longer exists to read.
 */
async function savedActiveTabId(): Promise<unknown> {
  const raw: unknown = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'))
  const { projects } = raw as { projects?: { id?: string; activeTabId?: unknown }[] }
  return projects?.find((project) => project.id === 'id-scratch')?.activeTabId
}

/** Total tmux clients attached across every session on the test socket. */
async function attachedClients(): Promise<number> {
  try {
    const { stdout } = await run('tmux', [
      '-L', SOCKET, 'list-sessions', '-F', '#{session_attached}',
    ])
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce((total, count) => total + Number(count), 0)
  } catch {
    return 0
  }
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'pterm-tabs-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'pterm-tabs-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'pterm-tabs-root-'))
  projectCwd = await seedProject('scratch', 'Scratch')
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'pterm-tabs-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'pterm-tabs-claude-'))
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a second instance exits instead of opening its own session', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)

  // A second launch must not create a second session. The launch itself can
  // reject when the app quits before opening a window, which is exactly the
  // behaviour under test, so a rejection counts as "exited" too.
  let secondStatus: 'exited' | 'still running'
  let second: ElectronApplication | null = null
  try {
    second = await launch()
    secondStatus = await second.evaluate(({ app }) => app.getVersion()).then(
      () => 'still running' as const,
      () => 'exited' as const,
    )
  } catch {
    secondStatus = 'exited'
  }
  expect(secondStatus).toBe('exited')
  if (second && secondStatus === 'still running') {
    await second.close()
  }

  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 10_000 }).toBe(1)

  await first.close()
})

test('opens several tabs and keeps each one\'s scrollback', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()

  await window.getByTestId('terminal-active').click()
  await window.keyboard.type('echo first-tab')
  await window.keyboard.press('Enter')
  await expect
    .poll(async () => activeTerminalText(window), { timeout: 20_000 })
    .toContain('first-tab')

  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  await window.getByTestId('terminal-active').click()
  await window.keyboard.type('echo second-tab')
  await window.keyboard.press('Enter')
  await expect
    .poll(async () => activeTerminalText(window), { timeout: 20_000 })
    .toContain('second-tab')
  // The first tab's content is hidden, not gone.
  expect(await activeTerminalText(window)).not.toContain('first-tab')

  const tabs = window.locator('[data-testid^="tab-"]')
  await expect(tabs).toHaveCount(2)
  await tabs.first().click()
  await expect
    .poll(async () => activeTerminalText(window), { timeout: 20_000 })
    .toContain('first-tab')

  await app.close()
})

test('restores every tab and the active one after a relaunch', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible()
  await firstWindow.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  await firstWindow.getByTestId('terminal-active').click()
  await firstWindow.keyboard.type('echo marker-two')
  await firstWindow.keyboard.press('Enter')
  await expect
    .poll(async () => activeTerminalText(firstWindow), { timeout: 20_000 })
    .toContain('marker-two')
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.locator('[data-testid^="tab-"]')).toHaveCount(2)
  // The second tab was active when we quit, and its scrollback came back.
  await expect
    .poll(async () => activeTerminalText(secondWindow), { timeout: 20_000 })
    .toContain('marker-two')
  await second.close()
})

test('a restored background tab keeps its size instead of being squashed', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible()
  await firstWindow.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  await firstWindow.waitForTimeout(1500)

  const names = (await sessionNames(SOCKET)).sort()
  const before = [await windowSize(names[0]), await windowSize(names[1])]
  // The app window is far wider than tmux's 80×24 default, so a pane that
  // never measured itself is unmistakable.
  expect(before[0]).not.toBe('80x24')
  expect(before[0]).toBe(before[1])
  await first.close()

  // Only one of these two comes back visible. The hidden one is attached by
  // the same client, and tmux sizes the session to whatever that client says.
  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.locator('[data-testid^="tab-"]')).toHaveCount(2)
  await expect
    .poll(async () => [await windowSize(names[0]), await windowSize(names[1])], {
      timeout: 20_000,
    })
    .toEqual(before)
  // And it stays that way rather than settling back down.
  await secondWindow.waitForTimeout(1500)
  expect([await windowSize(names[0]), await windowSize(names[1])]).toEqual(before)

  await second.close()
})

test('a relaunch lands on the tab that closing another one activated', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible()
  await firstWindow.getByTestId('new-tab').click()
  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.locator('[data-testid^="tab-"]')).toHaveCount(3)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(3)

  const ids = await firstWindow
    .locator('[data-testid^="tab-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''))

  // Work on the middle tab, then close it. The third becomes active — and
  // that, not the first, is where the next launch has to land.
  await firstWindow.getByTestId(ids[1]).click()
  await expect(firstWindow.locator(ACTIVE_TAB)).toHaveAttribute('data-testid', ids[1])
  await firstWindow.getByTestId(ids[1].replace('tab-', 'close-')).click()
  await expect(firstWindow.locator(ACTIVE_TAB)).toHaveAttribute('data-testid', ids[2])
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  // Let the config write land before the app goes away.
  await firstWindow.waitForTimeout(1000)
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.locator('[data-testid^="tab-"]')).toHaveCount(2)
  await expect(secondWindow.locator(ACTIVE_TAB)).toHaveAttribute('data-testid', ids[2])
  // A launch that restores tabs must not report an active tab before it knows
  // of one: writing `null` at mount would wipe the value restore is reading.
  await secondWindow.waitForTimeout(1000)
  expect(await savedActiveTabId()).toBe(ids[2].replace('tab-', ''))
  await second.close()
})

test('adopts a session the app has never seen', async () => {
  // Exactly what a crash or an external tmux command leaves behind.
  await run('tmux', [
    '-L', SOCKET, 'new-session', '-d', '-s', 'pterm-scratch-abcdef0123456789', 'sleep', '600',
  ])

  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect(window.getByTestId('tab-abcdef0123456789')).toBeVisible()

  await app.close()
})

test('reloading the window reattaches what is open instead of stranding it', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  const before = (await sessionNames(SOCKET)).sort()

  // Exactly what View → Reload, or a renderer crash, does.
  await app.evaluate(({ BrowserWindow }) => {
    const [target] = BrowserWindow.getAllWindows()
    target.webContents.reload()
  })

  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(2)
  // Long enough for a restore that found nothing to have opened a stray.
  await window.waitForTimeout(1500)
  expect((await sessionNames(SOCKET)).sort()).toEqual(before)

  await app.close()
})

test('a detach from inside the pane leaves the tab and its session alone', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const before = await sessionNames(SOCKET)

  // Wait for a prompt: tmux must be up before it will act on its prefix key.
  await window.getByTestId('terminal-active').click()
  await expect
    .poll(async () => activeTerminalText(window), { timeout: 20_000 })
    .toMatch(/[$%#]/)

  // The tmux user's reflex. The client dies; the session does not.
  await window.keyboard.press('Control+b')
  await window.keyboard.press('d')
  await expect.poll(attachedClients, { timeout: 20_000 }).toBe(0)
  // Long enough that a renderer deleting the tab on any exit event would have.
  await window.waitForTimeout(1500)

  expect(await sessionNames(SOCKET)).toEqual(before)
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  await app.close()
})

// ⌘T, ⌘W and ⌥⌘1–9 are the milestone's headline feature and had no test at any
// level. This drives the renderer's handler, which is where the logic lives;
// it does not exercise the OS accelerator layer.
test('the keyboard opens, switches and closes tabs', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const firstTab =
    (await window.locator('[data-testid^="tab-"]').first().getAttribute('data-testid')) ?? ''
  expect(firstTab).not.toBe('')

  await window.keyboard.press('Meta+t')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(2)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  // The new tab takes over, so ⌥⌘1 has somewhere to switch back from.
  await expect(window.locator(ACTIVE_TAB)).not.toHaveAttribute('data-testid', firstTab)

  // ⌥⌘1, not ⌘1: this milestone gave ⌘1–9 to the projects in the sidebar and
  // moved tab switching onto ⌥⌘1–9.
  await window.keyboard.press('Alt+Meta+1')
  await expect(window.locator(ACTIVE_TAB)).toHaveAttribute('data-testid', firstTab)

  // ⌘W closes the active tab, which is now the first one, and destroys
  // exactly that session.
  const firstSession = `pterm-scratch-${firstTab.replace('tab-', '')}`
  expect(await sessionNames(SOCKET)).toContain(firstSession)
  await window.keyboard.press('Meta+w')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  expect(await sessionNames(SOCKET)).not.toContain(firstSession)

  await app.close()
})

/**
 * Click a File/View menu item by id, from inside the main process.
 *
 * Playwright cannot drive the macOS menu bar, so this exercises everything
 * except the OS drawing it: the item exists, has that id, and its handler runs.
 */
async function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no menu item with id ${itemId}`)
    item.click()
  }, id)
}

// The menu items existed to display their accelerators without claiming them
// from the renderer, which is right — but clicking one did nothing at all.
// Three of them, carried since M2a as "same shape as M2b's I2, fix them
// together".
test('the File and View menu items do what their accelerators do', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)

  await clickMenuItem(app, 'new-tab')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(2)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  await clickMenuItem(app, 'close-pane')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)

  // Both columns start collapsed on a fresh profile, and each has its own
  // item: Presets and Skills toggle independently of one another, so a click
  // on one must never move the other.
  const skills = window.getByTestId('skills-panel')
  const presets = window.getByTestId('presets-panel')
  await expect(skills).toHaveCount(0)
  await expect(presets).toHaveCount(0)
  // Hidden is an absence, not a strip: nothing of either column is on screen,
  // and the View menu items below are the way back.
  await expect(window.getByTestId('skills-toggle')).toHaveCount(0)
  await expect(window.getByTestId('presets-toggle')).toHaveCount(0)

  await clickMenuItem(app, 'toggle-presets')
  await expect(presets).toBeVisible()
  await expect(skills).toHaveCount(0)

  await clickMenuItem(app, 'toggle-presets')
  await expect(presets).toHaveCount(0)
  await expect(skills).toHaveCount(0)

  await clickMenuItem(app, 'toggle-skills')
  await expect(skills).toBeVisible()
  await expect(presets).toHaveCount(0)

  await clickMenuItem(app, 'toggle-skills')
  await expect(skills).toHaveCount(0)
  await expect(presets).toHaveCount(0)

  await app.close()
})

test('closing a tab destroys its session', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  const closeButtons = window.locator('[data-testid^="close-"]')
  await closeButtons.first().click()

  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)

  await app.close()
})

test('a renamed tab shows its name in the bar and survives a relaunch', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  // This file has no pane-id helper (`paneIds` lives in `splits.spec.ts` and
  // is not exported), and it already has the selector for the active tab, so
  // the id comes off that rather than a helper copied between files.
  const testid = await window.locator(ACTIVE_TAB).getAttribute('data-testid')
  const id = (testid ?? '').replace('tab-', '')
  expect(id).not.toBe('')

  // Double-click the label, type, commit.
  await window.getByTestId(`tablabel-${id}`).dblclick()
  const field = window.getByTestId(`tabinput-${id}`)
  await field.fill('payments api')
  await field.press('Enter')

  // The bar, which is the only surface in a normal project that lists panes
  // by name now. The sidebar's copy of this list was removed; `tabLabel` is
  // still shared, and Unsorted's rows are where that sharing is asserted.
  await expect(window.getByTestId(`tab-${id}`)).toContainText('payments api')

  await app.close()

  // The half no unit test can reach: the name has to be on disk and come back
  // through restore, not merely live in the renderer's state.
  const second = await launch()
  const reopened = await second.firstWindow()
  await expect(reopened.getByTestId(`tab-${id}`)).toContainText('payments api')

  // Blank clears it, and the bar goes back to slug and id.
  await reopened.getByTestId(`tablabel-${id}`).dblclick()
  const again = reopened.getByTestId(`tabinput-${id}`)
  await again.fill('')
  await again.press('Enter')
  await expect(reopened.getByTestId(`tab-${id}`)).toContainText(id.slice(0, 6))

  await second.close()
})

test('the context menu reaches the same rename field', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  const testid = await window.locator(ACTIVE_TAB).getAttribute('data-testid')
  const id = (testid ?? '').replace('tab-', '')

  await window.getByTestId(`tab-${id}`).click({ button: 'right' })

  // A human has to be able to SEE and hit the item, which neither
  // `toBeVisible()` nor the click below can establish: Playwright scrolls the
  // nearest scrollable ancestor before clicking, and `toBeVisible()` asks only
  // for a non-empty box. Both passed while the menu was clipped out of sight
  // by the bar's own overflow. Measured in the built app on 2026-08-03: menu
  // 70..100.5 against a bar ending at 70, and `elementFromPoint` at the item's
  // centre returning the terminal's `.xterm-screen`. This asks the page what is
  // actually on top at that point instead.
  //
  // Waited for first: the `evaluate` below reads the element straight out of
  // the DOM, so without this a menu that has not rendered yet throws a
  // TypeError rather than failing the assertion.
  await window.getByTestId(`trename-${id}`).waitFor()
  const onTop = await window.evaluate((tabId) => {
    const item = document.querySelector(`[data-testid="trename-${tabId}"]`) as HTMLElement
    const box = item.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return hit === null ? 'nothing' : (hit.closest('[data-testid]')?.getAttribute('data-testid') ?? 'untagged')
  }, id)
  expect(onTop).toBe(`trename-${id}`)

  await window.getByTestId(`trename-${id}`).click()

  // Two entry points into one path, so this only has to prove it arrives.
  await expect(window.getByTestId(`tabinput-${id}`)).toBeVisible()

  await app.close()
})

test('the palette names a renamed tab the way the bar does', async () => {
  // The fourth surface. `tabLabel` exists so the bar, the sidebar, the dead
  // pane and ⌘K cannot disagree, and the two tests above pin the first two,
  // but nothing covered the palette and a title together: the palette's own
  // tests in `skills.spec.ts` never name a tab, and the rename tests never
  // open the palette. A palette wired to its own copy of the slug template
  // would have passed every one of them.
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  const testid = await window.locator(ACTIVE_TAB).getAttribute('data-testid')
  const id = (testid ?? '').replace('tab-', '')
  expect(id).not.toBe('')

  // Read unnamed first, so the assertion after the rename is a change rather
  // than a string that happened to be there all along.
  await window.keyboard.press('Meta+k')
  const row = window.getByTestId(`palette-session-${id}`)
  await expect(row).toContainText(id.slice(0, 6))
  await window.keyboard.press('Escape')
  await expect(window.getByTestId('command-palette')).toBeHidden()

  await window.getByTestId(`tablabel-${id}`).dblclick()
  const field = window.getByTestId(`tabinput-${id}`)
  await field.fill('payments api')
  await field.press('Enter')
  await expect(window.getByTestId(`tab-${id}`)).toContainText('payments api')

  await window.keyboard.press('Meta+k')
  await expect(row).toContainText('payments api')
  // The negative is the load-bearing half. A palette that appended the name to
  // the fallback, or ignored the title and kept rendering the fallback, would
  // satisfy the line above on its own. The id is lowercase hex, so no slice of
  // it can hide inside `payments api`.
  await expect(row).not.toContainText(id.slice(0, 6))

  await app.close()
})

test('the tab menu offers the same colours as the pane', async () => {
  // The other entry point. A tab with one pane IS that pane, and the swatch
  // row is one component with two callers, but the two callers are separate
  // code: `TabBar` renders its own `<ColorSwatches>` and calls its own
  // `onRecolor`. `splits.spec.ts` covers the pane's right-click menu; nothing
  // covered this one, and a tab menu wired to a no-op would have passed
  // everything.
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  const testid = await window.locator(ACTIVE_TAB).getAttribute('data-testid')
  const id = (testid ?? '').replace('tab-', '')

  const background = async (): Promise<string> =>
    window.getByTestId(`pane-${id}`).evaluate((node) => getComputedStyle(node).backgroundColor)

  expect(await background()).toBe('rgb(9, 9, 11)')

  await window.getByTestId(`tab-${id}`).click({ button: 'right' })
  await expect(window.getByTestId(`swatches-${id}`)).toBeVisible()
  // `2c2c30`, and deliberately not the `232326` the pane-menu test picks: if
  // both tests named the same colour, a tab menu that somehow drove the pane
  // menu's path would still look right here.
  await window.getByTestId(`swatch-${id}-2c2c30`).click()

  await expect.poll(background, { timeout: 5_000 }).toBe('rgb(44, 44, 48)')

  // The menu closes on the pick rather than staying open over the pane.
  await expect(window.getByTestId(`tabmenu-${id}`)).toBeHidden()

  await app.close()
})
