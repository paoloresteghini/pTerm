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

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PRCLI_CONFIG_DIR: configDir,
      PRCLI_TMUX_SOCKET: SOCKET,
      // Never scan the developer's real ~/Code.
      PRCLI_PROJECTS_ROOT: projectsRoot,
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
})

test.afterEach(async () => {
  await killServer()
  for (const dir of [userDataDir, configDir, projectsRoot]) {
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
  await candidate('lumio')
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('add-project').click()
  await window.getByTestId('candidate-lumio').click()
  // The id is generated at add time, so assert on the count and the name
  // rather than on a testid we cannot predict.
  await expect(window.locator('[data-testid^="project-"]')).toHaveCount(1)
  await expect(window.getByTestId('sidebar')).toContainText('lumio')

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => (await sessionNames()).filter((n) => n.startsWith('prcli-lumio-')).length, {
      timeout: 20_000,
    })
    .toBe(1)

  await app.close()
})

test('the tab bar shows only the active project\'s tabs', async () => {
  const lumio = await candidate('lumio')
  const gco = await candidate('gco')
  await seed(
    [
      { id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null },
      { id: 'id-gco', name: 'GCO', slug: 'gco', cwd: gco, presets: [], activeTabId: null },
    ],
    'id-lumio',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  await window.getByTestId('project-id-gco').click()
  // GCO has no tabs yet, so the bar empties rather than showing Lumio's.
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(0)
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  await app.close()
})

test('⌘1 and ⌘2 switch project; ⌥⌘1 and ⌥⌘2 switch tab', async () => {
  const lumio = await candidate('lumio')
  const gco = await candidate('gco')
  await seed(
    [
      { id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null },
      { id: 'id-gco', name: 'GCO', slug: 'gco', cwd: gco, presets: [], activeTabId: null },
    ],
    'id-lumio',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await window.getByTestId('new-tab').click()
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(2)

  await window.keyboard.press('Meta+Digit2')
  await expect(window.getByTestId('project-id-gco')).toHaveAttribute('data-active', 'true')
  await window.keyboard.press('Meta+Digit1')
  await expect(window.getByTestId('project-id-lumio')).toHaveAttribute('data-active', 'true')

  const tabs = window.locator('[data-testid^="tab-"]')
  const first = await tabs.first().getAttribute('data-testid')
  await window.keyboard.press('Alt+Meta+Digit1')
  await expect(window.locator(`[data-testid="${first}"]`)).toHaveAttribute('data-active', 'true')

  await app.close()
})

test('a preset declared by the repository launches its command', async () => {
  const lumio = await candidate('lumio', {
    presets: [{ label: 'marker', command: 'echo preset-ran; sleep 600' }],
  })
  await seed(
    [{ id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null }],
    'id-lumio',
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
  const lumio = await candidate('lumio')
  const gco = await candidate('gco')
  await seed(
    [
      { id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null },
      { id: 'id-gco', name: 'GCO', slug: 'gco', cwd: gco, presets: [], activeTabId: null },
    ],
    'id-lumio',
  )
  const first = await launch()
  const firstWindow = await first.firstWindow()

  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await firstWindow.getByTestId('project-id-gco').click()
  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await firstWindow.getByTestId('terminal-active').click()
  await firstWindow.keyboard.type('echo gco-marker')
  await firstWindow.keyboard.press('Enter')
  await expect(firstWindow.getByTestId('terminal-active')).toContainText('gco-marker', {
    timeout: 20_000,
  })
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.getByTestId('project-id-gco')).toHaveAttribute('data-active', 'true')
  await expect(secondWindow.getByTestId('terminal-active')).toContainText('gco-marker', {
    timeout: 20_000,
  })
  await second.close()
})

test('an Unsorted tab can be filed into a project, keeping its session', async () => {
  const lumio = await candidate('lumio')
  await seed(
    [{ id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null }],
    'id-lumio',
  )
  // A session created behind the app's back, as a crash would leave.
  await run('tmux', [
    '-L', SOCKET, 'new-session', '-d', '-s', 'prcli-scratch-abcdef0123456789', 'sleep', '600',
  ])

  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('project-unsorted').click()
  await window.getByTestId('smove-abcdef0123456789').selectOption('id-lumio')

  await expect
    .poll(async () => (await sessionNames()).includes('prcli-lumio-abcdef0123456789'), {
      timeout: 20_000,
    })
    .toBe(true)
  // Renamed, not recreated: exactly one session, and the old name is gone.
  expect(await sessionNames()).toEqual(['prcli-lumio-abcdef0123456789'])
  // The point of filing a stray is to be able to see it afterwards. Unsorted is
  // empty now, so the window has to follow the tab into Lumio rather than stay
  // pointed at a row that no longer exists.
  await expect(window.getByTestId('project-id-lumio')).toHaveAttribute('data-active', 'true')
  await expect(window.getByTestId('tab-abcdef0123456789')).toBeVisible()

  await app.close()
})

test('a session whose project was removed shows under Unsorted, still alive', async () => {
  const lumio = await candidate('lumio')
  await seed(
    [{ id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null }],
    'id-lumio',
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

  await window.getByTestId('pmenu-id-lumio').click()
  await window.getByTestId('premove-id-lumio').click()

  await expect(window.getByTestId('project-unsorted')).toBeVisible()
  // Removing a project destroys nothing: the session is still running.
  expect(await sessionNames()).toEqual(before)

  await app.close()
})
