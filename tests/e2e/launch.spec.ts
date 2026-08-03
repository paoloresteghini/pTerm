/**
 * The app starting, drawing a terminal, and finding its session again.
 *
 * Four tests, each against the packaged build (`npm run package`, run once for
 * the whole suite by `tests/e2e/global-setup.ts`) and a real tmux server on
 * the `prcli-e2e` socket: typed input reaches the shell and its output comes
 * back; a quit and relaunch reattaches the same session with its scrollback;
 * closing the window and reopening it through macOS `activate` reattaches
 * rather than replacing, leaving exactly one `prcli-` session on the socket;
 * and a fourth that opens no tmux session at all — it reads the five `PRCLI_*`
 * env vars back out of the launched app's own `process.env` and asserts each
 * equals the exact value this file handed `launchApp` (four temp paths made
 * in `beforeEach`, plus the `SOCKET` const), not merely that it is set to
 * something.
 *
 * **Measured, 2026-08-02, this file run alone** (`npx playwright test
 * tests/e2e/launch.spec.ts`), against the three tests that existed at the
 * time: renaming `data-testid="terminal"` to `terminal-box` in
 * `src/renderer/Terminal.tsx` fails all three — 3 failed, 0 passed,
 * reproduced on a second independent run. So the file is load-bearing for a
 * terminal being on screen at all. It is also the bluntest of the four
 * mutations Task 1 measured: everything those three tests wait on is that one
 * testid, so a failure among them says "no terminal", not which of the three
 * behaviours broke. Unmeasured against that mutation is the fourth test added
 * after: it never opens a tab or looks at the terminal, so it would survive a
 * `terminal-box` rename intact — the one "passes anyway" case in this file,
 * and expected, since it is checking something else entirely.
 *
 * **What this file does NOT see** — read off this file's own text unless a
 * line says measured or names another file:
 *
 * - **anything past one pane in one tab.** Every tab is opened with `+`, the
 *   seeded config's `tabs` is always `[]`, and nothing here presses ⌘D, so
 *   every tab has exactly one pane and every group renders exactly one box,
 *   whose share renormalises to 1. `PaneDivider` is constructed only for
 *   `index > 0` (`src/renderer/App.tsx:806-807`, read 2026-08-02), so not one
 *   is ever constructed: no divider is on screen in any test here, and nothing
 *   in this file can see a divider, a share, or a drag. Stated as what renders
 *   rather than as which branch runs, because the branch reading was wrong:
 *   an earlier version of this line said `boxesOfRow` is never reached, and
 *   **measured, 2026-08-02** — `boxesOfRow` mutated to `throw` on entry — this
 *   file went 2 failed, 2 passed. The two relaunch tests redden, because
 *   restore builds one tab row per live pane (`src/main/ipc/restore.ts:427`),
 *   so every pane has a row from the second launch on. It is reached; it is
 *   just only ever reached with a single kid;
 * - `DeadPane`. No test here kills a session behind the app's back, and no
 *   test in this file asserts on `dead-`, `pane-dot-`, `pane-restart-` or
 *   `pane-dismiss-` at all. Measured in `status.spec.ts`, which kills a
 *   session: making `DeadPane` render `null` left it 10 of 10 green. That
 *   mutation is no longer suite-wide silent — `splits.spec.ts` kills one pane
 *   of a split and asserts on `dead-` and `pane-restart-`, and the same
 *   mutation reddens it — but it is still silent here;
 * - **the keyboard.** ⌘T, ⌘W, ⌘D and ⌥⌘1–9 are never pressed here; the only
 *   keys this file sends are typed into the terminal itself. Untested rather
 *   than measured — no mutation of `App.tsx`'s keydown handler was run
 *   against this file;
 * - **the tab bar as a list.** One tab exists at a time, so nothing here
 *   distinguishes the active tab from another, and no `tab-` testid is
 *   asserted on. That is `tabs.spec.ts`'s ground;
 * - **hook events, status dots and project switching** — `status.spec.ts` and
 *   `projects.spec.ts` respectively. This file seeds exactly one project and
 *   touches nothing but `new-tab`, `terminal` and `.xterm-rows` — the
 *   sidebar, the settings pane and the add-project dialog are never clicked;
 * - **what the shell actually printed**, beyond one marker string appearing in
 *   `.xterm-rows`. Rendering fidelity, wrapping, colour and resize behaviour
 *   are all outside it.
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, killServer, sessionNames } from './harness'

// The app runs against its own tmux server here. Nothing these tests create
// is visible on the user's default socket, and nothing they clean up can
// reach the user's real sessions.
const SOCKET = 'prcli-e2e'

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
// be missing PRCLI_CLAUDE_SETTINGS.
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

// A config dir per test: the launches within a test share it, which is what
// proves reattachment, while the tests stay independent of one another.
test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-e2e-root-'))
  projectCwd = await seedProject('scratch', 'Scratch')
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
  claudeHome = await mkdtemp(join(tmpdir(), 'prcli-e2e-claude-'))
})

test.afterEach(async () => {
  // Destroys the test tmux server, taking every session this file created
  // with it — and only those, because of the `-L`.
  await killServer(SOCKET)
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir, claudeHome]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('renders a terminal and echoes typed input', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  const terminal = window.getByTestId('terminal')
  await expect(terminal).toBeVisible()

  // Click first so xterm's hidden textarea has focus before typing.
  await terminal.click()
  await window.keyboard.type('echo e2e-marker')
  await window.keyboard.press('Enter')

  await expect(window.locator('.xterm-rows')).toContainText('e2e-marker', { timeout: 20_000 })
  await app.close()
})

test('reattaches the same session with scrollback after relaunch', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal')).toBeVisible()
  await firstWindow.getByTestId('terminal').click()
  await firstWindow.keyboard.type('echo survives-restart')
  await firstWindow.keyboard.press('Enter')
  await expect(firstWindow.locator('.xterm-rows')).toContainText('survives-restart', {
    timeout: 20_000,
  })
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.locator('.xterm-rows')).toContainText('survives-restart', {
    timeout: 20_000,
  })
  await second.close()
})

// On macOS the app survives its window. Reopening must reattach the session
// that is still running, not silently replace it with a fresh one and leak
// the original.
test('reattaches the same session after closing and reopening the window', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal')).toBeVisible()
  await window.getByTestId('terminal').click()
  await window.keyboard.type('echo survives-window-close')
  await window.keyboard.press('Enter')
  await expect(window.locator('.xterm-rows')).toContainText('survives-window-close', {
    timeout: 20_000,
  })

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), {
      timeout: 20_000,
    })
    .toBe(0)

  const reopening = app.waitForEvent('window')
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit('activate')
  })
  const reopened = await reopening
  await expect(reopened.locator('.xterm-rows')).toContainText('survives-window-close', {
    timeout: 20_000,
  })

  // One session, not two: a replacement rather than a reattach would leave the
  // original running and invisible.
  const sessions = await sessionNames(SOCKET)
  expect(sessions.filter((name) => name.startsWith('prcli-'))).toHaveLength(1)

  await app.close()
})

// tests/unit/e2eSafety.test.ts checks that `harness.ts`'s source text sets all
// five PRCLI_* vars, and that no spec launches Electron around it — but a var
// pointing at the wrong path satisfies that check just as well as a var
// pointing at the right one, and neither half of it can see what this file
// passes to `launchApp`. Only a runtime read from inside the launched app can
// tell the difference, which is what this test does.
//
// It opens no tmux session and costs no pty — but not because it clicks
// nothing. A launch against a NON-empty socket adopts every `prcli-` session
// it finds there with no click at all (`tabs.spec.ts`'s `adopts a session the
// app has never seen`). What makes this test free is the pair either side of
// it: `beforeEach` seeds a fresh config whose `tabs` is `[]`, and `afterEach`
// runs `killServer`, so the socket this launch meets is empty.
//
// What it does NOT check is whether the paths it compares against are
// themselves safe. It asserts main received what this file intended; a
// `beforeEach` that set `claudeSettingsPath` to `join(homedir(), '.claude',
// 'settings.json')` would satisfy both this test and `e2eSafety.test.ts`'s
// token check. That the temp paths are temp is read off `beforeEach` by eye.
test('runs against overridden paths, never the developer’s own', async () => {
  const app = await launch()
  const seen = await app.evaluate(() => ({
    config: process.env.PRCLI_CONFIG_DIR,
    projects: process.env.PRCLI_PROJECTS_ROOT,
    settings: process.env.PRCLI_CLAUDE_SETTINGS,
    claudeHome: process.env.PRCLI_CLAUDE_HOME,
    socket: process.env.PRCLI_TMUX_SOCKET,
  }))
  // Asserted as "is the temp path we made", not as "is set": an override
  // pointing at the wrong place is set, and is exactly as dangerous.
  expect(seen.config).toBe(configDir)
  expect(seen.projects).toBe(projectsRoot)
  expect(seen.settings).toBe(claudeSettingsPath)
  expect(seen.claudeHome).toBe(claudeHome)
  expect(seen.socket).toBe(SOCKET)
  await app.close()
})
