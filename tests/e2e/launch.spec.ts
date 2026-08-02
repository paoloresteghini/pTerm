/**
 * The app starting, drawing a terminal, and finding its session again.
 *
 * Three tests, each against the packaged build (`npm run package` in
 * `beforeAll`) and a real tmux server on the `prcli-e2e` socket: typed input
 * reaches the shell and its output comes back; a quit and relaunch reattaches
 * the same session with its scrollback; and closing the window and reopening
 * it through macOS `activate` reattaches rather than replacing, leaving
 * exactly one `prcli-` session on the socket.
 *
 * **Measured, 2026-08-02, this file run alone** (`npx playwright test
 * tests/e2e/launch.spec.ts`): renaming `data-testid="terminal"` to
 * `terminal-box` in `src/renderer/Terminal.tsx` fails all three — 3 failed,
 * 0 passed, reproduced on a second independent run. So the file is
 * load-bearing for a terminal being on screen at all. It is also the bluntest
 * of the four mutations Task 1 measured: everything here waits on that one
 * testid, so a failure in this file says "no terminal", not which of the
 * three behaviours broke. This file therefore has no recorded edit that it
 * survives: the one mutation measured against it took all three tests with
 * it, so there is nothing here of the "passes anyway" kind the other three
 * headers record.
 *
 * **What this file does NOT see** — read off this file's own text unless a
 * line says measured:
 *
 * - **anything past one pane in one tab.** Every tab is opened with `+`, the
 *   seeded config's `tabs` is always `[]`, and nothing here presses ⌘D. With
 *   one pane per tab, `paneGroups` only ever takes its single-box branch
 *   (one box at `share: 1`), `boxesOfRow` is never reached, and the dividers
 *   overlay renders empty — `PaneDivider` is constructed only for
 *   `index > 0`. Nothing in this file can see a divider, a share, or a drag;
 * - `DeadPane`. No test here kills a session behind the app's back, and no
 *   test in this suite asserts on `dead-`, `pane-dot-`, `pane-restart-` or
 *   `pane-dismiss-` at all. Measured in `status.spec.ts`, the one file that
 *   does kill a session: making `DeadPane` render `null` left it 10 of 10
 *   green;
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
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

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

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // Keep the app's config out of the real ~/.prcli during tests.
      PRCLI_CONFIG_DIR: configDir,
      PRCLI_TMUX_SOCKET: SOCKET,
      // Nothing here opens the add-project dialog, so nothing should scan —
      // but the default root is the developer's real ~/Code, and defending a
      // directory that must not be touched costs one line.
      PRCLI_PROJECTS_ROOT: projectsRoot,
      // Read by every live Claude session on this machine. Set in every test
      // here, including the ones that never open the settings pane — the
      // same rule PRCLI_PROJECTS_ROOT got after 2b, for a file with far more
      // riding on it.
      PRCLI_CLAUDE_SETTINGS: claudeSettingsPath,
    },
  })
}

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

/** Destroy the test tmux server, taking every session this file created with it. */
async function killServer(): Promise<void> {
  await run('tmux', ['-L', SOCKET, 'kill-server']).catch(() => undefined)
}

test.beforeAll(async () => {
  await run('npm', ['run', 'package'])
})

// A config dir per test: the launches within a test share it, which is what
// proves reattachment, while the tests stay independent of one another.
test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-e2e-root-'))
  projectCwd = await seedProject('scratch', 'Scratch')
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
})

test.afterEach(async () => {
  await killServer()
  for (const dir of [userDataDir, configDir, projectsRoot, projectCwd, claudeSettingsDir]) {
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
  const { stdout } = await run('tmux', ['-L', SOCKET, 'list-sessions', '-F', '#{session_name}'])
  const sessions = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  expect(sessions.filter((name) => name.startsWith('prcli-'))).toHaveLength(1)

  await app.close()
})
