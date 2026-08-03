/**
 * The status board: hook events arriving over the socket, the dots they draw,
 * and the hook install that is supposed to produce them.
 *
 * Ten tests on the `prcli-e2e-status` socket: an injected event moves a tab's
 * dot; a `claude` tab starts hollow rather than silent; a project row takes
 * the worst of its tabs; Needs You lists a waiting tab and clicking it moves
 * both the selected project and the selected tab; the board survives a
 * renderer reload, because the registry lives in main; a spooled line replays
 * across a relaunch and is drained, not copied; a tab whose session is killed
 * lingers with a real state and a working Restart; a tab whose own command
 * exits non-zero goes red and strands no session; an event naming a tab id
 * nothing knows about does not inflate the dock badge; and install/uninstall
 * leave an unrelated hook untouched.
 *
 * **Measured, 2026-08-02, this file run alone** (`npx playwright test
 * tests/e2e/status.spec.ts`): making `CHANNELS.installHooks` resolve without
 * writing — `ipcMain.handle(CHANNELS.installHooks, () => readHooksState())`
 * in `src/main/ipc/register.ts` — fails one test, `install and uninstall
 * leave an unrelated hook untouched`, and the other nine pass. 1 failed, 9
 * passed, reproduced on a second independent run. Nine tests passing under a
 * dead install is not a gap in them: they inject hook lines straight onto the
 * socket and never depend on an install having happened.
 *
 * **What this file does NOT see** — read off this file's own text unless a
 * line says measured or names another file:
 *
 * - **`DeadPane`, measured.** This is the only spec in the suite that kills a
 *   pane's session, so it is the only one that could see the dead-pane
 *   chrome — and it does not. Making `DeadPane` return `null` outright left
 *   this file 10 of 10 green (2026-08-02). `a dead tab lingers, then restarts`
 *   drives `TabBar`'s `restart-<id>`, not the pane overlay's
 *   `pane-restart-<id>`; nothing in this suite references `dead-`,
 *   `pane-dot-`, `pane-restart-` or `pane-dismiss-` at all. The overlay's dot,
 *   its Restart and its Dismiss are unwitnessed here;
 * - **anything past one pane in one tab.** Every tab is opened through the UI
 *   with `tabs: []` seeded and nothing presses ⌘D, so every tab has exactly
 *   one pane and every group renders exactly one box, whose share renormalises
 *   to 1. `PaneDivider` is constructed only for `index > 0`
 *   (`src/renderer/App.tsx:806-807`, read 2026-08-02), so not one is ever
 *   constructed and the dividers overlay renders with no strips. A dead *pane*
 *   beside a live one, which is the case the overlay exists for, cannot occur
 *   here. Stated as what renders rather than as which branch runs: an earlier
 *   version of this line said `boxesOfRow` is never reached, and it is —
 *   restore builds one tab row per live pane, so the spool test's relaunch
 *   goes through it. Measured in `launch.spec.ts` (2026-08-02, `boxesOfRow`
 *   mutated to throw: 2 failed, 2 passed). It is only ever reached with a
 *   single kid;
 * - **the installed hook script actually running.** `injectHook` opens the
 *   socket and writes a line itself; `formatHookLine` keeps that honest as to
 *   wire format, but nothing here executes the script the install writes, and
 *   no real Claude process is involved. That the file Claude reads causes
 *   Claude to call it is untested at this level;
 * - **the real `~/.claude/settings.json`.** `PRCLI_CLAUDE_SETTINGS` points at
 *   a temp file in every test in this file, including the ones that never
 *   open the settings pane. The install is measured against a fixture;
 * - **`crashed` from a killed session.** See the long note on `a dead tab
 *   lingers, then restarts`: the attaching client exits 0 whatever killed the
 *   session, so that test asserts `ended` deliberately. The red dot is
 *   covered only by the separate `exit 3` test, which reads tmux's own
 *   `pane_dead_status`;
 * - **notification delivery.** `DEFAULT_NOTIFICATIONS` is seeded and the dock
 *   badge is read, but no test here asserts that a sound played, that a system
 *   notification was posted, or that muting a project suppresses one;
 * - **tab and project mechanics** — `tabs.spec.ts` and `projects.spec.ts`.
 *   One relaunch happens here, in the spool test, and it asserts only that a
 *   spooled line replayed onto that tab's dot; which tabs come back, in what
 *   order, and which project and tab a launch lands on are asserted nowhere in
 *   this file. Neither is a rename, a removal, or a second instance.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, mkdir, appendFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { launchApp, killServer, sessionNames } from './harness'
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

// Every launch in this file goes through the shared harness, so all four
// overrides are set by construction rather than by four copies of one env
// block that could drift apart — which is how three of the four specs came to
// be missing PRCLI_CLAUDE_SETTINGS.
const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, userDataDir })

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
      // Every tab in this suite is opened through the UI: `App.tsx`'s
      // `launch` now takes its `type` from the caller (the right panel's
      // `claude` button, a repo/user preset, or the default `shell` for
      // ⌘T/+) rather than leaving it unset for `SessionManager.open` to
      // default — see the "a claude tab starts hollow, not silent" test
      // below. Nothing here hand-seeds a tab row.
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

test.beforeEach(async () => {
  await killServer(SOCKET)
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-status-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-status-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-status-root-'))
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-status-settings-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
})

test.afterEach(async () => {
  await killServer(SOCKET)
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

// I1: `App.tsx`'s only `open` call site used to send no `type` at all, so
// `SessionManager.open` defaulted every tab — including one opened through
// the right panel's dedicated `claude` button — to `shell`. `stateForOpen`
// never got a chance to draw the hollow `unknown` dot the spec built for
// exactly this case: a `claude` tab with no hook events yet, so a broken
// hook install shows as a visible ring rather than as nothing at all.
test('a claude tab starts hollow, not silent', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  const before = await window.locator('[data-testid^="tab-"]').count()
  await window.getByTestId('preset-default-claude').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  const tabs = window.locator('[data-testid^="tab-"]')
  await expect(tabs).toHaveCount(before + 1)
  const testId = await tabs.last().getAttribute('data-testid')
  const id = (testId ?? '').replace('tab-', '')
  expect(id).not.toBe('')

  await expect(window.getByTestId(`dot-${id}`)).toHaveAttribute('data-state', 'unknown')

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
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
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
  await expect.poll(async () => (await sessionNames(SOCKET)).includes(name), { timeout: 20_000 }).toBe(true)

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
    .poll(async () => (await sessionNames(SOCKET)).includes(name), { timeout: 20_000 })
    .toBe(true)

  await app.close()
})

// M3's own acceptance criterion, unmet when M3 merged and discharged here: a
// crashed command "stays put, red". The tab above dies by `kill-session`,
// which is somebody deliberately destroying a session and correctly reads as
// `ended`. This one dies the way `npm run dev` dies — its own command exits
// non-zero — which is the case the red dot exists for.
test('a tab whose command crashes goes red, stays put, and strands no session', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  const id = await openTab(window)
  const name = `prcli-alpha-${id}`
  await expect.poll(async () => (await sessionNames(SOCKET)).includes(name), { timeout: 20_000 }).toBe(true)

  // Typed into the tab's own shell, so the status comes from the pane's
  // command rather than from anything the app did.
  // Trailing colon: a pane target, not a session target. Without it tmux says
  // "can't find pane" — the same gotcha M2a's P7 records.
  await run('tmux', ['-L', SOCKET, 'send-keys', '-t', `=${name}:`, 'exit 3', 'Enter'])

  await expect(window.getByTestId(`dot-${id}`)).toHaveAttribute('data-state', 'crashed', {
    timeout: 20_000,
  })
  await expect(window.getByTestId(`tab-${id}`)).toBeVisible()

  // `remain-on-exit` is what makes the status readable, and it also stops tmux
  // reaping the session. If the hook's own `kill-session` ever stopped firing,
  // every crash would leave a stray behind.
  await expect
    .poll(async () => (await sessionNames(SOCKET)).includes(name), { timeout: 20_000 })
    .toBe(false)

  await app.close()
})

// I5: `parseHookLine` only validates the *shape* of `tabId` — sixteen hex
// characters — not that it names a tab this app actually has. The socket is
// reachable by anything on the machine that can open it, so an event for an
// id nothing knows about used to create a permanent entry in the registry:
// nothing in the UI can ever reach it to dismiss or kill it, so it inflates
// `waitingCount()` — and the dock badge — until the app restarts.
test('an event for a tab id nothing knows about does not inflate the dock badge', async () => {
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
  await expect
    .poll(async () => app.evaluate(({ app: electronApp }) => electronApp.dock?.getBadge()))
    .toBe('1')

  // Well-formed — sixteen hex characters, same as a real id — but not one
  // this app ever opened: exactly what a stray write to the socket, or an
  // event that lands after the tab it names was already killed, looks like.
  await injectHook('0000000000000000', 'Notification')
  // Nothing to poll toward for a negative assertion: the async membership
  // check (a `store.read()`) needs a moment to resolve either way, and the
  // badge must still read what it read before, not "2".
  await window.waitForTimeout(500)
  await expect(app.evaluate(({ app: electronApp }) => electronApp.dock?.getBadge())).resolves.toBe(
    '1',
  )

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
