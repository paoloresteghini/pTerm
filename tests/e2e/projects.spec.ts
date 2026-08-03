/**
 * Projects: discovering them, switching between them, renaming and removing
 * them, and what happens to their sessions when any of that occurs.
 *
 * Twelve tests on the `prcli-e2e-projects` socket: an empty workspace opens no
 * session; a scanned candidate can be added and a tab opened under its slug;
 * the tab bar shows only the active project's tabs; ⌘1/⌘2 switch project while
 * ⌥⌘1 switches tab; a repository-declared preset launches its command; a
 * relaunch restores the active project and each project's active tab; an
 * Unsorted stray is filed by *renaming* its session, not recreating it; a ⌘
 * shortcut typed into the rename field does not reach the tab handler, while
 * ⌘W with a terminal focused still closes its tab; a rename keeps the slug and
 * honours Escape, blur and a blank name; removing a project leaves its
 * session alive under Unsorted; the welcome page is up when a selected
 * project has no session and returns when its last pane closes; and it names
 * the missing directory when the active project's cwd is gone.
 *
 * **Measured, 2026-08-02, this file run alone** (`npx playwright test
 * tests/e2e/projects.spec.ts`): deleting the `if (event.altKey)` branch from
 * the `Digit` handler in `App.tsx` — so ⌥⌘1 falls through to project
 * switching — fails one test, `⌘1 and ⌘2 switch project; ⌥⌘1 and ⌥⌘2 switch
 * tab`, and the other nine pass: 1 failed, 9 passed of the ten tests the file
 * held that day, reproduced on a second independent run. The two halves of
 * that test's name are not equally pinned by it: the failure lands on the
 * ⌥⌘1 assertion, which means the ⌘1 and ⌘2 assertions ahead of it passed
 * under the mutation. Only the half the mutation was aimed at moved.
 *
 * **Also measured** the same day: changing `event.code === 'KeyW'` to
 * `'KeyQ'` in the same handler fails `a shortcut typed into the rename field
 * does not reach the tab handler` here — at its last assertion, the one that
 * checks ⌘W still closes a tab with a terminal focused — and nothing else in
 * this file. So that test really does bite on ⌘W and not only on the guard it
 * is named for.
 *
 * **Measured, 2026-08-03, this file run alone**: pinning `showWelcome`
 * in `App.tsx` to `true` fails `the welcome page goes when a session opens
 * and returns when it closes` at its `toBeHidden()`, catching a broken
 * must-hide direction: 1 failed, 10 passed of the eleven tests the file held
 * that day. Pinning it to `false` catches the broken must-show direction the
 * same way, but at more than the one test this note used to name: it also
 * fails `starts with no projects and opens no session`, since that test
 * asserts on `getByTestId('welcome')` too. 2 failed, 9 passed of the same
 * eleven, derived by reading both tests rather than re-running the mutation.
 * Since `showWelcome` is one value recomputed identically at every point in
 * the test, that also bounds the closing reappearance assertion, though
 * neither mutation run reaches it directly: each dies on its own earlier
 * failure first.
 *
 * **What this file does NOT see** — read off this file's own text unless a
 * line says measured or names another file:
 *
 * - **anything past one pane in one tab.** Nothing here presses ⌘D and every
 *   seeded config carries `tabs: []`, so each tab has exactly one pane and
 *   each group renders exactly one box, whose share renormalises to 1.
 *   `PaneDivider` is constructed only for `index > 0`
 *   (`src/renderer/App.tsx:812-813`, read 2026-08-03), so not one is ever
 *   constructed and the dividers overlay renders with no strips. Stated as
 *   what renders rather than as which branch runs: an earlier version of this
 *   line said `boxesOfRow` is never reached, and it is — restore builds one
 *   tab row per live pane, so the relaunch test here goes through it.
 *   Measured in `launch.spec.ts` (2026-08-02, `boxesOfRow` mutated to throw:
 *   2 failed, 2 passed). It is only ever reached with a single kid, which is
 *   why no divider follows;
 * - `DeadPane`. No test here kills a session behind the app's back, and no
 *   test in this file asserts on `dead-`, `pane-dot-`, `pane-restart-` or
 *   `pane-dismiss-` at all. Measured in `status.spec.ts`, which does kill a
 *   session: making `DeadPane` render `null` left it 10 of 10 green. The
 *   overlay is witnessed in `splits.spec.ts`, which kills one pane of a split
 *   and reddens under that same mutation — but nothing of it is witnessed
 *   here;
 * - **the native folder picker.** `choose-folder` opens a dialog Playwright
 *   cannot touch, so the add path exercised here is the scanned-candidate
 *   list only, and every other project is seeded straight into `config.json`;
 * - **the real scan root.** `PRCLI_PROJECTS_ROOT` points at a temp directory
 *   in every test, so discovery is measured against fixtures, never against
 *   `~/Code`. What a scan of a large real tree costs or finds is untested;
 * - **status dots, hook events and the dock badge** — `status.spec.ts`. No
 *   test here injects an event or asserts on a `dot-` or `pdot-` testid;
 * - **project reordering and mute**, and anything in the settings pane: no
 *   test here opens it;
 * - **the OS accelerator layer.** ⌘1/⌥⌘1/⌘W are dispatched into the window by
 *   Playwright; that the physical keystroke reaches the window at all is
 *   outside this file;
 * - **whether a launch reaches `createWindow()` at all.** About one full-suite
 *   run in twenty dies before it does — a known pre-existing flake, and macOS
 *   rather than this app; the mechanism and its measured rate are at the
 *   `launch` const below. Nothing here asserts on startup reliability: when it
 *   bites, the run reports a timeout instead of reporting anything about
 *   projects.
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames } from './harness'

const run = promisify(execFile)
const SOCKET = 'prcli-e2e-projects'

let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string
let claudeHome: string

// Every launch in this file goes through the shared harness, so all five
// overrides are set by construction rather than by four copies of one env
// block that could drift apart — which is how three of the four specs came to
// be missing PRCLI_CLAUDE_SETTINGS.
//
// Known pre-existing flake, measured 2026-08-03 at **2 failures in 43
// full-suite runs** on an idle machine (~4.7% of runs, ~1 in 1,000 launches):
// a test here throws `electronApplication.firstWindow: Timeout 30000ms
// exceeded` from `app.firstWindow()` below, plus a worker teardown timeout.
//
// It is macOS, not this app. AppKit blocks the launch in `-[NSAlert runModal]`
// under `promptToIgnorePersistentStateWithCrashHistory:` — the "reopen
// windows?" panel, with nobody there to click it — which suppresses
// `finishLaunching`, so Electron's `ready` never fires and no window is ever
// created. Confirmed by `sample(1)` on a live stalled process. **No PRCLI code
// has run when it hangs**: `ready` → window took ≤141ms across 1,654
// instrumented launches, so `adapter.version()` (≤10ms) and
// `hookServer.start()` (≤3ms) — which this comment used to name as the suspect
// region — are excluded by three orders of magnitude. Do not go looking in
// `src/main`.
//
// The alert's state is keyed on the shared Electron bundle id, not on the
// per-test `--user-data-dir`, so **concurrent E2E runs raise the rate** — the
// "roughly 1 in 3" this comment used to claim was measured with three agents
// plus a controller running this suite at once. `harness.ts` passes
// `-ApplePersistenceIgnoreState` at every launch as a mitigation; see the
// comment there for what that is and is not known to do. Raising the
// `firstWindow` timeout is the one clearly wrong fix: the stall ends when
// Playwright tears the process down, not on its own, so a bigger number buys a
// longer hang. `retries: 0` (`playwright.config.ts`) does not retry it; that is
// deliberate, not an oversight — see that file's comment.
const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, claudeHome, userDataDir })

/** A directory under the scan root that discovery will offer as a candidate. */
async function candidate(name: string, manifest?: object): Promise<string> {
  const cwd = join(projectsRoot, name)
  await mkdir(join(cwd, '.git'), { recursive: true })
  if (manifest) await writeFile(join(cwd, '.prcli.json'), JSON.stringify(manifest), 'utf8')
  return cwd
}

async function seed(projects: object[], activeProjectId: string | null): Promise<void> {
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({ version: 3, projects, activeProjectId, tabs: [] }),
    'utf8',
  )
}

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-proj-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-proj-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-proj-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-proj-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-proj-claude-'))
})

test.afterEach(async () => {
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('starts with no projects and opens no session', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('welcome')).toBeVisible()
  await expect(window.getByTestId('welcome-hint')).toContainText(
    'select a working directory to start',
  )
  expect(await sessionNames(SOCKET)).toEqual([])
  await app.close()
})

test('adds a scanned candidate and opens a tab in it', async () => {
  await candidate('alpha')
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('add-project').click()
  await window.getByTestId('candidate-alpha').click()
  // The id is generated at add time, so assert on the count and the name
  // rather than on a testid we cannot predict.
  await expect(window.locator('[data-testid^="project-"]')).toHaveCount(1)
  await expect(window.getByTestId('sidebar')).toContainText('alpha')

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => (await sessionNames(SOCKET)).filter((n) => n.startsWith('prcli-alpha-')).length, {
      timeout: 20_000,
    })
    .toBe(1)

  await app.close()
})

test('the tab bar shows only the active project\'s tabs', async () => {
  const alpha = await candidate('alpha')
  const beta = await candidate('beta')
  await seed(
    [
      { id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null },
      { id: 'id-beta', name: 'Beta', slug: 'beta', cwd: beta, presets: [], activeTabId: null },
    ],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  await window.getByTestId('project-id-beta').click()
  // Beta has no tabs yet, so the bar empties rather than showing Alpha's.
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(0)
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  await app.close()
})

test('⌘1 and ⌘2 switch project; ⌥⌘1 and ⌥⌘2 switch tab', async () => {
  const alpha = await candidate('alpha')
  const beta = await candidate('beta')
  await seed(
    [
      { id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null },
      { id: 'id-beta', name: 'Beta', slug: 'beta', cwd: beta, presets: [], activeTabId: null },
    ],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await window.getByTestId('new-tab').click()
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(2)

  await window.keyboard.press('Meta+Digit2')
  await expect(window.getByTestId('project-id-beta')).toHaveAttribute('data-active', 'true')
  await window.keyboard.press('Meta+Digit1')
  await expect(window.getByTestId('project-id-alpha')).toHaveAttribute('data-active', 'true')

  const tabs = window.locator('[data-testid^="tab-"]')
  const first = await tabs.first().getAttribute('data-testid')
  await window.keyboard.press('Alt+Meta+Digit1')
  await expect(window.locator(`[data-testid="${first}"]`)).toHaveAttribute('data-active', 'true')

  await app.close()
})

test('a preset declared by the repository launches its command', async () => {
  const alpha = await candidate('alpha', {
    presets: [{ label: 'marker', command: 'echo preset-ran; sleep 600' }],
  })
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('preset-marker').click()
  await expect(window.getByTestId('terminal-active')).toContainText('preset-ran', {
    timeout: 20_000,
  })

  await app.close()
})

test('restores the active project and each project\'s active tab', async () => {
  const alpha = await candidate('alpha')
  const beta = await candidate('beta')
  await seed(
    [
      { id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null },
      { id: 'id-beta', name: 'Beta', slug: 'beta', cwd: beta, presets: [], activeTabId: null },
    ],
    'id-alpha',
  )
  const first = await launch()
  const firstWindow = await first.firstWindow()

  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await firstWindow.getByTestId('project-id-beta').click()
  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await firstWindow.getByTestId('terminal-active').click()
  await firstWindow.keyboard.type('echo beta-marker')
  await firstWindow.keyboard.press('Enter')
  await expect(firstWindow.getByTestId('terminal-active')).toContainText('beta-marker', {
    timeout: 20_000,
  })
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.getByTestId('project-id-beta')).toHaveAttribute('data-active', 'true')
  await expect(secondWindow.getByTestId('terminal-active')).toContainText('beta-marker', {
    timeout: 20_000,
  })
  await second.close()
})

test('an Unsorted tab can be filed into a project, keeping its session', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  // A session created behind the app's back, as a crash would leave.
  await run('tmux', [
    '-L', SOCKET, 'new-session', '-d', '-s', 'prcli-scratch-abcdef0123456789', 'sleep', '600',
  ])

  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('project-unsorted').click()
  await window.getByTestId('smove-abcdef0123456789').selectOption('id-alpha')

  await expect
    .poll(async () => (await sessionNames(SOCKET)).includes('prcli-alpha-abcdef0123456789'), {
      timeout: 20_000,
    })
    .toBe(true)
  // Renamed, not recreated: exactly one session, and the old name is gone.
  expect(await sessionNames(SOCKET)).toEqual(['prcli-alpha-abcdef0123456789'])
  // The point of filing a stray is to be able to see it afterwards. Unsorted is
  // empty now, so the window has to follow the tab into Alpha rather than stay
  // pointed at a row that no longer exists.
  await expect(window.getByTestId('project-id-alpha')).toHaveAttribute('data-active', 'true')
  await expect(window.getByTestId('tab-abcdef0123456789')).toBeVisible()

  await app.close()
})

// The window-level ⌘ handler stayed live while the rename field had focus, so
// a ⌘W typed mid-rename closed a tab and threw the rename away with it. Two
// losses from one keystroke, and the tab is the expensive one.
test('a shortcut typed into the rename field does not reach the tab handler', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)

  await window.getByTestId('pmenu-id-alpha').click()
  await window.getByTestId('prename-id-alpha').click()
  const renaming = window.getByTestId('rename-input-id-alpha')
  await renaming.fill('Half typed')

  await renaming.press('Meta+w')

  // The tab is still there, its session with it, and the edit is still open.
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 5_000 }).toBe(1)
  await expect(renaming).toBeVisible()
  await expect(renaming).toHaveValue('Half typed')

  // ⌘T is the same handler and the same mistake.
  await renaming.press('Meta+t')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  // And the shortcut still works the moment the field is gone.
  await renaming.press('Enter')
  await expect(window.getByTestId('project-id-alpha')).toContainText('Half typed')
  await window.keyboard.press('Meta+t')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(2)

  // The case the guard could easily have broken: xterm's focus target is a
  // `<textarea>`, so a blanket "ignore shortcuts inside form fields" rule
  // would disable ⌘W exactly where this app is used. With a terminal focused,
  // ⌘W must still close its tab.
  await window.getByTestId('terminal-active').click()
  await window.keyboard.press('Meta+w')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  await app.close()
})

test('a project can be renamed in place, keeping its slug', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('pmenu-id-alpha').click()
  await window.getByTestId('prename-id-alpha').click()
  const input = window.getByTestId('rename-input-id-alpha')
  await input.fill('Renamed')
  await input.press('Enter')

  await expect(window.getByTestId('project-id-alpha')).toContainText('Renamed')
  await expect(window.getByTestId('sidebar')).not.toContainText('Alpha')

  // Escape discards. The blur that follows unmounting the input must not then
  // commit what Escape threw away.
  await window.getByTestId('pmenu-id-alpha').click()
  await window.getByTestId('prename-id-alpha').click()
  await window.getByTestId('rename-input-id-alpha').fill('Discarded')
  await window.getByTestId('rename-input-id-alpha').press('Escape')
  await expect(window.getByTestId('project-id-alpha')).toContainText('Renamed')
  await expect(window.getByTestId('sidebar')).not.toContainText('Discarded')

  // Focus leaving the field commits, so a rename is not lost by clicking away.
  await window.getByTestId('pmenu-id-alpha').click()
  await window.getByTestId('prename-id-alpha').click()
  await window.getByTestId('rename-input-id-alpha').fill('Blurred')
  await window.getByTestId('rename-input-id-alpha').press('Tab')
  await expect(window.getByTestId('project-id-alpha')).toContainText('Blurred')

  // A name of nothing but spaces is not a rename. The guard has existed since
  // M2b with no test biting on it, so this is that test: a blank commit leaves
  // the previous name in place rather than an empty row nobody can identify.
  await window.getByTestId('pmenu-id-alpha').click()
  await window.getByTestId('prename-id-alpha').click()
  await window.getByTestId('rename-input-id-alpha').fill('   ')
  await window.getByTestId('rename-input-id-alpha').press('Enter')
  await expect(window.getByTestId('project-id-alpha')).toContainText('Blurred')

  // The slug is baked into the tmux name of every session this project has
  // opened, so renaming must not re-slug: doing so would orphan all of them.
  // A new tab still lands under the original slug.
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => (await sessionNames(SOCKET)).map((name) => name.replace(/-[0-9a-f]{16}$/, '')), {
      timeout: 20_000,
    })
    .toEqual(['prcli-alpha'])

  await app.close()
})

test('a session whose project was removed shows under Unsorted, still alive', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  // Wait for tmux, not just for the tab. `open` returns once `tmux new-session`
  // has been forked, which is before the server has created the session — so a
  // visible terminal does not yet mean a listable session, and reading the list
  // straight away sees an empty one. Every other session count here polls for
  // the same reason.
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const before = await sessionNames(SOCKET)
  expect(before).toHaveLength(1)

  await window.getByTestId('pmenu-id-alpha').click()
  await window.getByTestId('premove-id-alpha').click()

  await expect(window.getByTestId('project-unsorted')).toBeVisible()
  // Removing a project destroys nothing: the session is still running.
  expect(await sessionNames(SOCKET)).toEqual(before)

  await app.close()
})

test('the welcome page goes when a session opens and returns when it closes', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  // A project is selected and nothing is running in it. This is the state the
  // sentence this page replaced could not describe: it only appeared when
  // there were no projects at all, so this launch used to show a blank box.
  await expect(window.getByTestId('welcome')).toBeVisible()
  // The wordmark and the shortcut copy: nothing else in this file asserts on
  // them, so without this `pTerm` could silently become `PRCLI` with the
  // suite green.
  await expect(window.getByTestId('welcome')).toContainText('pTerm')
  await expect(window.getByTestId('welcome')).toContainText(
    'Manage Claude Code sessions across clients and departments.',
  )
  await expect(window.getByTestId('welcome')).toContainText('Cmd+T')
  await expect(window.getByTestId('welcome')).toContainText('Cmd+D')
  await expect(window.getByTestId('welcome')).toContainText('Cmd+Shift+D')
  await expect(window.getByTestId('welcome-hint')).toContainText('press Cmd+T to start a session')

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect(window.getByTestId('welcome')).toBeHidden()

  // ⌘W with the terminal focused, the same way `a shortcut typed into the
  // rename field does not reach the tab handler` closes its last tab.
  await window.getByTestId('terminal-active').click()
  await window.keyboard.press('Meta+w')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(0)
  await expect(window.getByTestId('welcome')).toBeVisible()

  await app.close()
})

test('names the missing directory when the active project cwd is gone', async () => {
  // Not created through `candidate()`: the point is a cwd that is not there,
  // so main's `isDirectory` check (`src/main/ipc/restore.ts`) sets
  // `available: false` and drives the hint's fourth branch.
  const gone = join(projectsRoot, 'ghost')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: gone, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await expect(window.getByTestId('welcome')).toBeVisible()
  await expect(window.getByTestId('welcome-hint')).toContainText(`${gone} is missing`)

  await app.close()
})
