import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, mkdir, appendFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { formatHookLine } from '../../src/main/hooks/protocol'
import { HOOK_EVENTS, type HookEvent } from '../../src/main/status/machine'
import { DEFAULT_NOTIFICATIONS } from '../../src/main/state/store'

const run = promisify(execFile)
const SOCKET = 'prcli-e2e-status'

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
    JSON.stringify({
      version: 4,
      projects,
      activeProjectId,
      // Every tab in this suite is opened through the UI, which always
      // writes a `type` — nothing here hand-seeds a tab row.
      tabs: [],
      notifications: DEFAULT_NOTIFICATIONS,
    }),
    'utf8',
  )
}

/**
 * Connect to the app's hook socket and write one line, exactly what the
 * installed hook script does. `formatHookLine` is the same function the main
 * process uses to parse it, so this cannot drift from the real wire format.
 */
async function injectHook(tabId: string, event: HookEvent): Promise<void> {
  const socketPath = join(configDir, 'hook.sock')
  await new Promise<void>((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(formatHookLine({ tabId, event, at: Date.now() }))
    })
    client.on('close', () => resolve())
    client.on('error', reject)
  })
}

/** Open a tab in whichever project is currently active and return its id. */
async function openTab(window: Page): Promise<string> {
  const before = await window.locator('[data-testid^="tab-"]').count()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  const tabs = window.locator('[data-testid^="tab-"]')
  await expect(tabs).toHaveCount(before + 1)
  const testId = await tabs.last().getAttribute('data-testid')
  const id = (testId ?? '').replace('tab-', '')
  expect(id).not.toBe('')
  return id
}

test.beforeAll(async () => {
  await run('npm', ['run', 'package'])
})

test.beforeEach(async () => {
  await killServer()
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-status-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-status-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-status-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-status-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
})

test.afterEach(async () => {
  await killServer()
  for (const dir of [userDataDir, configDir, projectsRoot, claudeSettingsDir]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a dot appears for an injected event', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  const id = await openTab(window)

  await injectHook(id, 'UserPromptSubmit')
  await expect(window.getByTestId(`dot-${id}`)).toHaveAttribute('data-state', 'thinking')

  await injectHook(id, 'Notification')
  await expect(window.getByTestId(`dot-${id}`)).toHaveAttribute('data-state', 'waiting')

  await app.close()
})

test('a project row takes the worst of its tabs', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  const idle = await openTab(window)
  const waiting = await openTab(window)

  await injectHook(idle, 'Stop')
  await expect(window.getByTestId(`dot-${idle}`)).toHaveAttribute('data-state', 'idle')
  await injectHook(waiting, 'Notification')
  await expect(window.getByTestId(`dot-${waiting}`)).toHaveAttribute('data-state', 'waiting')

  // `waiting` outranks `idle`, so the row shows the worse of the two even
  // though the idle tab was the more recent event.
  await expect(window.getByTestId('pdot-id-alpha')).toHaveAttribute('data-state', 'waiting')

  await app.close()
})

test('Needs You lists it, and clicking it lands on the tab', async () => {
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

  // A tab in Alpha, so there is somewhere for the click below to navigate
  // away from.
  await openTab(window)

  await window.getByTestId('project-id-beta').click()
  const needy = await openTab(window)
  await injectHook(needy, 'Notification')
  await expect(window.getByTestId(`dot-${needy}`)).toHaveAttribute('data-state', 'waiting')

  // Land back on Alpha before checking Needs You, so the click has to move
  // both the selected project and the selected tab to prove anything.
  await window.getByTestId('project-id-alpha').click()
  await expect(window.getByTestId('project-id-alpha')).toHaveAttribute('data-active', 'true')

  await expect(window.getByTestId('needs-you-count')).toHaveText('1')
  await window.getByTestId(`needs-${needy}`).click()

  await expect(window.getByTestId('project-id-beta')).toHaveAttribute('data-active', 'true')
  await expect(window.getByTestId(`tab-${needy}`)).toHaveAttribute('data-active', 'true')

  await app.close()
})

test('the board survives a reload', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  const id = await openTab(window)
  await injectHook(id, 'Notification')
  await expect(window.getByTestId(`dot-${id}`)).toHaveAttribute('data-state', 'waiting')

  // Exactly what View → Reload does. The registry this reads back from lives
  // in the main process, which the reload does not touch — that is the
  // entire point of keeping it there rather than in renderer state.
  await window.reload()

  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect(window.getByTestId(`dot-${id}`)).toHaveAttribute('data-state', 'waiting', {
    timeout: 20_000,
  })

  await app.close()
})

test('the spool replays across a relaunch', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const first = await launch()
  const firstWindow = await first.firstWindow()

  const id = await openTab(firstWindow)
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(1)
  await first.close()

  // Exactly what the hook script does when the socket write fails because
  // nothing is listening — the app is down.
  const spoolPath = join(configDir, 'hook.spool')
  await appendFile(spoolPath, formatHookLine({ tabId: id, event: 'Notification', at: Date.now() }), 'utf8')

  const second = await launch()
  const secondWindow = await second.firstWindow()

  await expect(secondWindow.getByTestId(`dot-${id}`)).toHaveAttribute('data-state', 'waiting', {
    timeout: 20_000,
  })

  // Drained, not copied: a second relaunch must not replay it again.
  let spoolSurvived = true
  try {
    await readFile(spoolPath, 'utf8')
  } catch {
    spoolSurvived = false
  }
  expect(spoolSurvived).toBe(false)

  await second.close()
})

test('a dead tab lingers, then restarts', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  const id = await openTab(window)
  const name = `prcli-alpha-${id}`
  await expect.poll(async () => (await sessionNames()).includes(name), { timeout: 20_000 }).toBe(true)

  // Exactly what a crash outside the app leaves behind: the client is gone
  // and so is the session, with nothing routed through manager.kill().
  await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${name}`])

  // Not `crashed`, though the brief this suite is modelled on calls for it,
  // and the doc comment on `stateForExit` (src/main/status/machine.ts) reads
  // "non-zero is a crash worth a red dot." Measured directly, three ways,
  // against the real tmux client `PtySession` spawns (`new-session -A`,
  // which is what `code` in `registry.applyExit(id, code)` actually comes
  // from): `kill-session` on the one session a client is attached to exits
  // 0; a pane's own command exiting non-zero (`sh -c "exit 7"`) still exits
  // 0; only `kill-server` — destroying every session on the socket at
  // once — exits 1. tmux does not hand its attaching client the pane's exit
  // status or the reason a session went away; `stateForExit`'s premise holds
  // only for the server dying outright, not for the single-tab crash this
  // feature and this test exist to show. `code` is always 0 here, so the tab
  // reaches `ended`, not `crashed` — a real defect, reported rather than
  // patched here: fixing it needs a second signal tmux does not give the
  // client today (e.g. `remain-on-exit` plus reading `#{pane_dead_status}`
  // before the session disappears), which is an architecture change well
  // past an E2E suite's scope. What this test still proves honestly: the
  // dead tab lingers with a real state and a working Restart.
  await expect(window.getByTestId(`dot-${id}`)).toHaveAttribute('data-state', 'ended', {
    timeout: 20_000,
  })
  // Dead, not gone: the row stays so Restart and Dismiss have something to
  // act on.
  await expect(window.getByTestId(`tab-${id}`)).toBeVisible()

  await window.getByTestId(`restart-${id}`).click()
  await expect
    .poll(async () => (await sessionNames()).includes(name), { timeout: 20_000 })
    .toBe(true)

  await app.close()
})

interface HookFileGroup {
  matcher?: string
  hooks: { type?: string; command?: string }[]
}

type HookFile = Record<string, unknown> & { hooks?: Record<string, HookFileGroup[]> }

function hasPrcliHook(groups: HookFileGroup[] | undefined): boolean {
  return (groups ?? []).some((group) =>
    group.hooks.some((hook) => typeof hook.command === 'string' && hook.command.includes('/bin/prcli-hook')),
  )
}

test('install and uninstall leave an unrelated hook untouched', async () => {
  // Modelled on install.test.ts's `realistic()`: a matcher-bearing group on
  // an event PRCLI itself subscribes to, which is the case that actually
  // exercises "append, never edit, reorder or replace".
  const fixture = {
    otherSetting: 'kept',
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: '/usr/local/bin/some-other-tool' }],
        },
      ],
    },
  }
  await writeFile(claudeSettingsPath, JSON.stringify(fixture, null, 2), 'utf8')

  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('settings-open').click()
  await expect(window.getByTestId('hooks-status')).toHaveText('not installed')

  await window.getByTestId('hooks-install').click()
  await expect(window.getByTestId('hooks-status')).toHaveText('installed')

  const afterInstall = JSON.parse(await readFile(claudeSettingsPath, 'utf8')) as HookFile
  const installedHooks = afterInstall.hooks ?? {}
  // The fixture's own group survives, untouched and first in the array —
  // appended past, never edited.
  expect(installedHooks.PreToolUse?.[0]).toEqual(fixture.hooks.PreToolUse[0])
  // PRCLI's own group is now on every event it subscribes to, including the
  // one the fixture already partially populated.
  for (const event of HOOK_EVENTS) {
    expect(hasPrcliHook(installedHooks[event])).toBe(true)
  }

  await window.getByTestId('hooks-uninstall').click()
  await expect(window.getByTestId('hooks-status')).toHaveText('not installed')

  const afterUninstall = JSON.parse(await readFile(claudeSettingsPath, 'utf8')) as unknown
  // Byte-for-byte in effect: uninstall restores exactly the object that was
  // seeded, not merely something structurally similar to it.
  expect(afterUninstall).toEqual(fixture)

  await app.close()
})
