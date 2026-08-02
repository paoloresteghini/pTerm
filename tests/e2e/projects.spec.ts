/**
 * Projects: discovering them, switching between them, renaming and removing
 * them, and what happens to their sessions when any of that occurs.
 *
 * Ten tests on the `prcli-e2e-projects` socket: an empty workspace opens no
 * session; a scanned candidate can be added and a tab opened under its slug;
 * the tab bar shows only the active project's tabs; ⌘1/⌘2 switch project while
 * ⌥⌘1 switches tab; a repository-declared preset launches its command; a
 * relaunch restores the active project and each project's active tab; an
 * Unsorted stray is filed by *renaming* its session, not recreating it; a ⌘
 * shortcut typed into the rename field does not reach the tab handler, while
 * ⌘W with a terminal focused still closes its tab; a rename keeps the slug and
 * honours Escape, blur and a blank name; and removing a project leaves its
 * session alive under Unsorted.
 *
 * **Measured, 2026-08-02, this file run alone** (`npx playwright test
 * tests/e2e/projects.spec.ts`): deleting the `if (event.altKey)` branch from
 * the `Digit` handler in `App.tsx` — so ⌥⌘1 falls through to project
 * switching — fails one test, `⌘1 and ⌘2 switch project; ⌥⌘1 and ⌥⌘2 switch
 * tab`, and the other nine pass. 1 failed, 9 passed, reproduced on a second
 * independent run. The two halves of that test's name are not equally pinned
 * by it: the failure lands on the ⌥⌘1 assertion, which means the ⌘1 and ⌘2
 * assertions ahead of it passed under the mutation. Only the half the
 * mutation was aimed at moved.
 *
 * **Also measured** the same day: changing `event.code === 'KeyW'` to
 * `'KeyQ'` in the same handler fails `a shortcut typed into the rename field
 * does not reach the tab handler` here — at its last assertion, the one that
 * checks ⌘W still closes a tab with a terminal focused — and nothing else in
 * this file. So that test really does bite on ⌘W and not only on the guard it
 * is named for.
 *
 * **What this file does NOT see** — read off this file's own text unless a
 * line says measured or names another file:
 *
 * - **anything past one pane in one tab.** Nothing here presses ⌘D and every
 *   seeded config carries `tabs: []`, so each tab has exactly one pane and
 *   each group renders exactly one box, whose share renormalises to 1.
 *   `PaneDivider` is constructed only for `index > 0`
 *   (`src/renderer/App.tsx:806-807`, read 2026-08-02), so not one is ever
 *   constructed and the dividers overlay renders with no strips. Stated as
 *   what renders rather than as which branch runs: an earlier version of this
 *   line said `boxesOfRow` is never reached, and it is — restore builds one
 *   tab row per live pane, so the relaunch test here goes through it.
 *   Measured in `launch.spec.ts` (2026-08-02, `boxesOfRow` mutated to throw:
 *   2 failed, 2 passed). It is only ever reached with a single kid, which is
 *   why no divider follows;
 * - `DeadPane`. No test here kills a session behind the app's back, and no
 *   test in this suite asserts on `dead-`, `pane-dot-`, `pane-restart-` or
 *   `pane-dismiss-` at all. Measured in `status.spec.ts`, which does kill a
 *   session: making `DeadPane` render `null` left it 10 of 10 green;
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
 *   outside this file.
 */
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const SOCKET = 'prcli-e2e-projects'

let userDataDir: string
let configDir: string
let projectsRoot: string
let claudeSettingsDir: string
let claudeSettingsPath: string

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PRCLI_CONFIG_DIR: configDir,
      PRCLI_TMUX_SOCKET: SOCKET,
      // Never scan the developer's real ~/Code.
      PRCLI_PROJECTS_ROOT: projectsRoot,
      // Read by every live Claude session on this machine. Set in every test
      // here, including the ones that never open the settings pane — the
      // same rule PRCLI_PROJECTS_ROOT got after 2b, for a file with far more
      // riding on it.
      PRCLI_CLAUDE_SETTINGS: claudeSettingsPath,
    },
  })
}

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

async function sessionNames(): Promise<string[]> {
  try {
    const { stdout } = await run('tmux', ['-L', SOCKET, 'list-sessions', '-F', '#{session_name}'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

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

test.beforeAll(async () => {
  await run('npm', ['run', 'package'])
})

test.beforeEach(async () => {
  await killServer()
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-proj-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-proj-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-proj-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-proj-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
})

test.afterEach(async () => {
  await killServer()
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('starts with no projects and opens no session', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('empty-state')).toBeVisible()
  expect(await sessionNames()).toEqual([])
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
    .poll(async () => (await sessionNames()).filter((n) => n.startsWith('prcli-alpha-')).length, {
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
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)
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
    .poll(async () => (await sessionNames()).includes('prcli-alpha-abcdef0123456789'), {
      timeout: 20_000,
    })
    .toBe(true)
  // Renamed, not recreated: exactly one session, and the old name is gone.
  expect(await sessionNames()).toEqual(['prcli-alpha-abcdef0123456789'])
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
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(1)

  await window.getByTestId('pmenu-id-alpha').click()
  await window.getByTestId('prename-id-alpha').click()
  const renaming = window.getByTestId('rename-input-id-alpha')
  await renaming.fill('Half typed')

  await renaming.press('Meta+w')

  // The tab is still there, its session with it, and the edit is still open.
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect.poll(async () => (await sessionNames()).length, { timeout: 5_000 }).toBe(1)
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
    .poll(async () => (await sessionNames()).map((name) => name.replace(/-[0-9a-f]{16}$/, '')), {
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
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(1)
  const before = await sessionNames()
  expect(before).toHaveLength(1)

  await window.getByTestId('pmenu-id-alpha').click()
  await window.getByTestId('premove-id-alpha').click()

  await expect(window.getByTestId('project-unsorted')).toBeVisible()
  // Removing a project destroys nothing: the session is still running.
  expect(await sessionNames()).toEqual(before)

  await app.close()
})
