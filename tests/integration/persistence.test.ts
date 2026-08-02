import { describe, it, expect, afterAll, afterEach, beforeEach, beforeAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Candidate,
  ExitEvent,
  HooksState,
  NotificationConfig,
  ProjectDescriptor,
  RestoreResult,
  TabDescriptor,
  TabShape,
  TabState,
} from '../../src/shared/ipc'

// registerIpc reaches for electron's ipcMain, which does not exist outside the
// main process. Capturing the handlers lets the real persistence path run.
const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => unknown>(),
  /** What the next folder dialog answers with. */
  folderChoice: { canceled: true, filePaths: [] as string[] },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => ipc.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: never[]) => unknown) => ipc.listeners.set(channel, fn),
  },
  // The folder picker reaches for this. It has to be here or vitest throws on
  // the missing export the moment that handler runs — the mock stands for the
  // whole electron module, so every part of it registerIpc touches belongs in it.
  dialog: { showOpenDialog: () => Promise.resolve(ipc.folderChoice) },
}))

const { CHANNELS, UNSORTED_ID } = await import('../../src/shared/ipc')
const { TmuxAdapter } = await import('../../src/main/tmux/adapter')
const { SessionManager } = await import('../../src/main/sessions/manager')
const { ConfigStore } = await import('../../src/main/state/store')
const { registerIpc } = await import('../../src/main/ipc/register')
const { StatusRegistry } = await import('../../src/main/status/registry')

type Manager = InstanceType<typeof SessionManager>
type Store = InstanceType<typeof ConfigStore>
type Registry = InstanceType<typeof StatusRegistry>
type Config = Awaited<ReturnType<Store['read']>>

const run = promisify(execFile)
const SOCKET = 'prcli-test'

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait for a shell prompt. Detaching before tmux has finished creating the
 * session kills the client first and leaves nothing behind to reattach to.
 */
function waitForPrompt(id: string, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for a prompt; saw ${JSON.stringify(buffer)}`)),
      ms,
    )
    manager.onData((emittedId, data) => {
      if (emittedId !== id) return
      buffer += data
      if (/\$|%|#/.test(buffer)) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

async function savedIds(store: Store): Promise<string[]> {
  // Pane rows, which are what `rememberTab`/`forgetTab` maintain. Config's tab
  // rows carry layout and would answer this question with the wrong list.
  return (await store.read()).panes.map((pane) => pane.id)
}

/** Poll the config until it matches, so an async write is not raced. */
async function waitForSavedIds(store: Store, expected: string[], ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    const ids = await savedIds(store)
    if (ids.length === expected.length && expected.every((id) => ids.includes(id))) return
    if (Date.now() > deadline) {
      throw new Error(`timed out; saved tabs were ${JSON.stringify(ids)}`)
    }
    await settle(50)
  }
}

function openTab(command?: string): Promise<{ id: string; tmuxSession: string }> {
  const handler = ipc.handlers.get(CHANNELS.open)
  if (!handler) throw new Error('open handler was not registered')
  return handler(null as never, { projectSlug: 'lumio', cwd: tmpdir(), command } as never) as Promise<{
    id: string
    tmuxSession: string
  }>
}

/** Like `openTab`, for the tests that care which project the tab lands in. */
function openTabIn(projectSlug: string): Promise<{ id: string; tmuxSession: string }> {
  const handler = ipc.handlers.get(CHANNELS.open)
  if (!handler) throw new Error('open handler was not registered')
  return handler(null as never, { projectSlug, cwd: tmpdir() } as never) as Promise<{
    id: string
    tmuxSession: string
  }>
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler(null as never, ...(args as never[])) as Promise<T>
}

function detachTab(id: string): void {
  const listener = ipc.listeners.get(CHANNELS.detach)
  if (!listener) throw new Error('detach listener was not registered')
  listener(null as never, id as never)
}

/**
 * Close a tab the way every gesture in the app now does.
 *
 * Through `CHANNELS.closePane`, which is the only channel that kills a pane:
 * the narrower `CHANNELS.kill` did the same work without maintaining the
 * closed pane's tab row, and two of those was one too many. Every tab these
 * tests open holds a single pane, so what comes back is an empty `TabShape`
 * and the kill is the whole of it.
 */
function killTab(id: string): Promise<TabShape> {
  const handler = ipc.handlers.get(CHANNELS.closePane)
  if (!handler) throw new Error('closePane handler was not registered')
  return handler(null as never, id as never) as Promise<TabShape>
}

function restoreTabs(): Promise<RestoreResult> {
  const handler = ipc.handlers.get(CHANNELS.restore)
  if (!handler) throw new Error('restore handler was not registered')
  return handler(null as never) as Promise<RestoreResult>
}

function resizeTab(id: string, cols: number, rows: number): void {
  const listener = ipc.listeners.get(CHANNELS.resize)
  if (!listener) throw new Error('resize listener was not registered')
  listener(null as never, id as never, cols as never, rows as never)
}

/** What tmux itself thinks the session's window measures. */
async function windowSize(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}',
  ])
  return stdout.trim()
}

/**
 * The tmux group a session is in, or `''` when it is in none.
 *
 * `=${name}:` WITH the trailing colon. Measured on this socket: `-t '=name'`
 * answers `#{session_group}` with an empty string and exits 0 for a session
 * that is demonstrably in a group, where `-t '=name:'` answers with the group
 * name. This helper was written the first way and passed a green suite for one
 * run, agreeing that two grouped sessions were both in no group at all.
 *
 * `''` is also what a lookup against a session tmux does not have returns —
 * `display-message` exits 0 with empty stdout for a missing target — so every
 * caller asserts non-empty before comparing two of these. Two failed lookups
 * agree perfectly.
 */
async function sessionGroup(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{session_group}',
  ])
  return stdout.trim()
}

/**
 * A window's own `window-size` option, as tmux prints it — `'window-size
 * manual'` when set, `''` when unset.
 *
 * The option, not the resulting size, and the difference is the whole point.
 * A window left unset inherits the global `latest` and follows its client; a
 * window forced to `manual` and resized to the same numbers the client happens
 * to have MEASURES IDENTICALLY. So `windowSize()` cannot tell an unsized
 * restart from one that drove the window to 80x24 — this can. Both readings
 * measured on `-L prcli-test`, each exiting 0.
 */
async function windowSizeOption(windowId: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'show-options', '-w', '-t', windowId, 'window-size',
  ])
  return stdout.trim()
}

/**
 * The config file exactly as a handler wrote it.
 *
 * Read raw rather than through `store.read()`, and every layout assertion in
 * this file must use it: `normaliseLayout` rescales EVERY ratio array by its
 * own total on the way in (`shares.map(share => share / total)`) and drops any
 * row whose kids have all gone. So a handler that wrote shares summing to 0.5,
 * or one that left a dead tab's row behind, reads back through `store.read()`
 * looking perfect — the reader repairs both on the way past, and the assertion
 * passes on the defect it was written for. Ported from restore.test.ts, which
 * needs it for exactly this reason.
 */
async function written(): Promise<Config> {
  return JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')) as Config
}

/**
 * A session's own environment entry for `key`, as tmux prints it —
 * `'PRCLI_TAB_ID=<id>'`, or `''` when there is none and when the session is not
 * there at all. Every caller compares it against a non-empty expected string,
 * so the two failures cannot pass as an answer.
 */
async function sessionEnv(name: string, key: string): Promise<string> {
  try {
    const { stdout } = await run('tmux', ['-L', SOCKET, 'show-environment', '-t', `=${name}`, key])
    return stdout.trim()
  } catch {
    return ''
  }
}

/** Type into a tab, through the same IPC listener a keystroke goes through. */
function writeToTab(id: string, data: string): void {
  const listener = ipc.listeners.get(CHANNELS.input)
  if (!listener) throw new Error('input listener was not registered')
  listener(null as never, id as never, data as never)
}

/**
 * What `$PRCLI_TAB_ID` expands to inside the pane's own running PROCESS.
 *
 * Not `show-environment`, which reads the session's environment table — a
 * different object, and not the one that matters. `addMember` sets the variable
 * twice for exactly this reason: `-e` on `new-window` reaches the spawned
 * pane's process and never the table, `-e` on `new-session -t <group>` reaches
 * the table and not the process. The installed hook script reads
 * `$PRCLI_TAB_ID` out of its own process environment (see `install.ts`), so a
 * regression dropping `-e` from `newWindow` would take every status dot out
 * while leaving a `show-environment` assertion perfectly green.
 *
 * Typed in rather than asked of tmux, because a process's environment is not
 * something tmux will report. The marker is printed with `printf` so that the
 * shell's echo of the command line — which comes straight back down the same
 * stream — reads `TABID[%s]` and not the expanded value. The `%` in the
 * character class is what excludes that echo, leaving the real output as the
 * only thing this can match. An unset variable prints `TABID[]` and is matched
 * as the empty string, so it fails on the comparison with a readable value
 * rather than by running out the clock.
 */
function paneEnvTabId(id: string, ms = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () =>
        reject(
          new Error(`timed out reading PRCLI_TAB_ID from ${id}; saw ${JSON.stringify(buffer)}`),
        ),
      ms,
    )
    manager.onData((emittedId, data) => {
      if (emittedId !== id) return
      buffer += data
      const found = /TABID\[([^\]%]*)\]/.exec(buffer)
      if (!found) return
      clearTimeout(timer)
      resolve(found[1])
    })
    // Registered above before this runs, so nothing printed can be missed.
    writeToTab(id, 'printf "TABID[%s]\\n" "$PRCLI_TAB_ID"\n')
  })
}

/** Resolves once the given tab's client has stopped, whatever the reason. */
function nextExit(id: string, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${id} to exit`)), ms)
    manager.onExit((record) => {
      if (record.id !== id) return
      clearTimeout(timer)
      resolve()
    })
  })
}

let fakeBinDir: string | undefined

/**
 * Real tmux, except that `kill-session` fails the way an unreachable socket
 * does. Nothing else can produce a kill that fails after the client is already
 * gone, which is the case that must not drop the record.
 */
async function tmuxRefusingKills(): Promise<string> {
  fakeBinDir ??= await mkdtemp(join(tmpdir(), 'prcli-fake-tmux-'))
  const bin = join(fakeBinDir, 'tmux')
  await writeFile(
    bin,
    '#!/bin/sh\n' +
      'for arg in "$@"; do\n' +
      '  if [ "$arg" = "kill-session" ]; then\n' +
      '    printf "%s\\n" "error connecting to /tmp/x (Permission denied)" >&2\n' +
      '    exit 1\n' +
      '  fi\n' +
      'done\n' +
      'exec tmux "$@"\n',
    'utf8',
  )
  await chmod(bin, 0o755)
  return bin
}

let configDir: string
let store: Store
let manager: Manager
let registry: Registry

/** Every payload registerIpc has sent to the renderer, in order. */
let sentEvents: Array<{ channel: string; payload: unknown }>

/** Rebuild the whole main-process wiring, optionally against a different tmux. */
function useManager(bin?: string): void {
  ipc.handlers.clear()
  ipc.listeners.clear()
  sentEvents = []
  manager = new SessionManager(new TmuxAdapter({ socket: SOCKET, bin }))
  registry = new StatusRegistry()
  // A minimal stand-in for BrowserWindow: registerIpc only ever calls
  // isDestroyed() and webContents.send(), so that is all this needs to supply.
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        sentEvents.push({ channel, payload })
      },
    },
  }
  registerIpc(manager, () => fakeWindow as never, registry, store)
}

/** Wait for the exit event a given tab sends to the renderer. */
function waitForExitEvent(id: string, ms = 8000): Promise<ExitEvent> {
  const deadline = Date.now() + ms
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const found = sentEvents.find(
        (event) =>
          event.channel === CHANNELS.exit && (event.payload as { id: string }).id === id,
      )
      if (found) {
        resolve(found.payload as ExitEvent)
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for an exit event for ${id}`))
        return
      }
      setTimeout(poll, 20)
    }
    poll()
  })
}

beforeAll(killServer)

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'prcli-persist-'))
  store = new ConfigStore(join(configDir, 'config.json'))
  ipc.folderChoice = { canceled: true, filePaths: [] }
  useManager()
})

afterEach(async () => {
  manager.detachAll()
  await killServer()
  await rm(configDir, { recursive: true, force: true })
})

afterAll(async () => {
  if (fakeBinDir) await rm(fakeBinDir, { recursive: true, force: true })
})

describe('durable tab record', () => {
  it('remembers a tab when it is opened', async () => {
    const tab = await openTab()
    expect(await savedIds(store)).toEqual([tab.id])
  })

  // The whole point of a detach: the session outlives the app, so the record
  // that brings it back must outlive the detach.
  it('survives a detach', async () => {
    const tab = await openTab()
    await waitForPrompt(tab.id)
    detachTab(tab.id)
    await settle(500)
    expect(await savedIds(store)).toEqual([tab.id])
  })

  it('survives detaching every tab, as happens on quit', async () => {
    const tab = await openTab()
    await waitForPrompt(tab.id)
    manager.detachAll()
    await settle(500)
    expect(await savedIds(store)).toEqual([tab.id])
  })

  it('is pruned by an explicit kill', async () => {
    const tab = await openTab()
    await killTab(tab.id)
    expect(await savedIds(store)).toEqual([])
  })

  it('is pruned when the session genuinely exits', async () => {
    await openTab('true')
    await waitForSavedIds(store, [])
  })

  // `Ctrl-b d` inside the pane. xterm passes the keystroke straight through,
  // so the client dies with no intent of ours — but the session is still
  // running, and the record is the only way back to it.
  it('survives a client death we did not cause', async () => {
    const tab = await openTab()
    await waitForPrompt(tab.id)
    const exited = nextExit(tab.id)

    await run('tmux', ['-L', SOCKET, 'detach-client', '-s', tab.tmuxSession])
    await exited
    // Long enough that a wrongly-pruning listener would have written by now.
    await settle(500)

    expect(manager.get(tab.id)).toBeUndefined()
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(true)
    expect(await savedIds(store)).toEqual([tab.id])
  })

  // The kill detaches the client before it destroys the session, so a kill
  // that then fails leaves a session running that only the record can reach.
  it('survives a kill that fails', async () => {
    useManager(await tmuxRefusingKills())
    const tab = await openTab()
    await waitForPrompt(tab.id)

    await expect(killTab(tab.id)).rejects.toThrow(/permission denied/i)
    await settle(500)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(true)
    expect(await savedIds(store)).toEqual([tab.id])
  })

  // `killed` must not be asserted dead just because we asked for it: the kill
  // can be refused, and the exit event the renderer draws its tab bar from has
  // to say so, or a live session drops off the screen with no way back to it.
  it('tells the renderer a killed session is still alive when the kill is refused', async () => {
    useManager(await tmuxRefusingKills())
    const tab = await openTab()
    await waitForPrompt(tab.id)
    const exitEvent = waitForExitEvent(tab.id)

    await expect(killTab(tab.id)).rejects.toThrow(/permission denied/i)

    await expect(exitEvent).resolves.toMatchObject({ id: tab.id, sessionAlive: true })

    const adapter = new TmuxAdapter({ socket: SOCKET })
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(true)
    expect(await savedIds(store)).toEqual([tab.id])
  })

  // I7: the renderer tells a kill the user asked for apart from a genuine
  // death by reading `reason` off the exit event (App.tsx: `if (reason ===
  // 'killed') return`), so it never draws a tombstone — with its resurrecting
  // ↻ Restart — for a tab that was just deliberately closed. That guard is
  // only as good as what `register.ts` puts on the wire: this asserts the
  // deliberate kill's own exit event actually carries `reason: 'killed'`
  // through to the renderer, not merely that some internal call was made with
  // it, which would pass even if `send` dropped the field again.
  it('carries reason "killed" on the exit event a deliberate kill sends the renderer', async () => {
    const tab = await openTab()
    await waitForPrompt(tab.id)
    const exitEvent = waitForExitEvent(tab.id)

    await killTab(tab.id)

    await expect(exitEvent).resolves.toMatchObject({ id: tab.id, reason: 'killed' })
  })

  it('does not lose other tabs when one is pruned', async () => {
    const kept = await openTab()
    const doomed = await openTab()
    await killTab(doomed.id)
    expect(await savedIds(store)).toEqual([kept.id])
  })

  // A detach followed by a relaunch is the promise the app is built on.
  it('reattaches a detached tab and does not duplicate its record', async () => {
    const tab = await openTab()
    await waitForPrompt(tab.id)
    detachTab(tab.id)
    await settle(500)

    const restored = await restoreTabs()
    // `restored.panes`, not `restored.tabs`: `tabs` is now `TabRow[]`, one
    // row per group, and `restoreWorkspace` builds those rows by grouping
    // panes into a Map keyed on tab id — so a bug that duplicated this pane's
    // record would still produce exactly one row and this test would not
    // catch the very regression it is named for.
    expect(restored.panes.map((entry) => entry.id)).toEqual([tab.id])
    expect(await savedIds(store)).toEqual([tab.id])
  })
})

// M3: `restartTab` had no test of any kind. The geometry code itself
// (`lastGeometry` in register.ts) was already right — this is the codebase's
// second attempt at exactly this defect (`SessionManager.moveToProject` has
// its own regression test in manager.test.ts:233) — but restart had shipped
// with no proof at all, which is precisely the shape a third attempt at the
// same defect goes unnoticed in.
describe('restartTab', () => {
  it('reattaches at the size lastGeometry remembered, not the 80x24 default', async () => {
    const tab = await invoke<TabDescriptor>(CHANNELS.open, { projectSlug: 'lumio', cwd: tmpdir() })
    await waitForPrompt(tab.id)

    resizeTab(tab.id, 111, 41)
    await expect.poll(() => windowSize(tab.tmuxSession), { timeout: 8000 }).toBe('111x41')

    // Exactly what a crash outside the app leaves behind: the client is gone
    // and so is the session, with nothing routed through manager.kill().
    const exitEvent = waitForExitEvent(tab.id)
    await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${tab.tmuxSession}`])
    await exitEvent

    const restarted = await invoke<TabDescriptor>(CHANNELS.restartTab, { tab })

    expect(restarted.tmuxSession).toBe(tab.tmuxSession)
    // No cols/rows in the request above, so this can only have come from
    // `lastGeometry` — the attach-at-80x24-default defect this codebase has
    // now shipped twice, proven fixed a second, independent way.
    await expect.poll(() => windowSize(restarted.tmuxSession), { timeout: 8000 }).toBe('111x41')
  })

  // I4. Restart recreated a pane with a bare `new-session -A`, which makes an
  // UNGROUPED session — so a pane of a split came back beside its tab instead
  // of in it, and the next restore, which groups panes by `session_group` and
  // nothing else, read it as a tab of its own. The split silently un-split.
  //
  // The sibling case: the dead pane is not the founder, so nothing left in tmux
  // or on disk says which tab it was in. Nothing in the request says either —
  // main remembers it from when the pane was created, which is what makes a
  // caller unable to omit it. See `SessionManager.tabWasIn`.
  it('restarts a split pane back into its tab group, not beside it', async () => {
    const founder = await openTab()
    await waitForPrompt(founder.id)
    const second = await manager.splitTab({ paneId: founder.id })
    await waitForPrompt(second.id)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    const group = await sessionGroup(founder.tmuxSession)
    expect(group).not.toBe('')
    expect(await sessionGroup(second.tmuxSession)).toBe(group)
    const secondWindow = await adapter.windowIdOf(second.tmuxSession)
    expect(secondWindow).toMatch(/^@\d+$/)

    // What the death hook does when a pane's process dies, in its order: the
    // member session, then the window it was bound to — see `deathHookCommand`.
    // This manager is built without a death reporter, so no hook is installed
    // here and these two commands stand in for it.
    const exitEvent = waitForExitEvent(second.id)
    await run('tmux', [
      '-L', SOCKET,
      'kill-session', '-t', `=${second.tmuxSession}`, ';', 'kill-window', '-t', secondWindow,
    ])
    await exitEvent
    await expect(adapter.hasSession(second.tmuxSession)).resolves.toBe(false)

    // No tab id in the request, and there is nowhere left for one to come
    // from: this pane's own id names no group, and the group is named after the
    // founder. Main's own record of which tab it made this pane in is the only
    // thing that can answer.
    const restarted = await invoke<TabDescriptor>(CHANNELS.restartTab, {
      tab: second,
      cols: 100,
      rows: 30,
    })

    expect(restarted.tmuxSession).toBe(second.tmuxSession)
    // Polled, not asserted straight off: the rejoin path creates this session
    // before it returns, but the `new-session -A` one it must not take spawns
    // a client and returns without waiting for tmux — so a plain assertion
    // here would fail on that path for a reason that is not the group, and
    // hide whether the group assertions below can catch anything at all.
    await expect.poll(() => adapter.hasSession(restarted.tmuxSession), { timeout: 8000 }).toBe(true)
    // The tab's own group — the one it had before, not a new one — with both
    // panes in it. Read back from tmux for each, and non-empty above.
    expect(await sessionGroup(restarted.tmuxSession)).toBe(group)
    expect(await sessionGroup(founder.tmuxSession)).toBe(group)
    // And bound to a window of its own before its client attached. A member
    // that attaches first lands on a sibling's window, and two xterms then
    // render one pane.
    const restartedWindow = await adapter.windowIdOf(restarted.tmuxSession)
    const siblingWindow = await adapter.windowIdOf(founder.tmuxSession)
    // Both sides guarded before they are compared. `windowIdOf` answers `''`
    // for any failure, so an unguarded right-hand side would let a tmux hiccup
    // satisfy this — vacuously, on the assertion that guards the very bug it
    // is here for.
    expect(restartedWindow).toMatch(/^@\d+$/)
    expect(siblingWindow).toMatch(/^@\d+$/)
    expect(restartedWindow).not.toBe(siblingWindow)
    // The window this pane was given, not a size nobody asked for: the request
    // carried 100x30.
    await expect.poll(() => windowSize(restarted.tmuxSession), { timeout: 8000 }).toBe('100x30')
  })

  // The founder case, and the one main answers with no help from the renderer:
  // a group keeps the name its founder had and outlives it, so the founder's
  // own id still names the group once its session is gone. No `tabId` in this
  // request — the fallback to the pane's own id is what is under test.
  it("restarts a tab's founder back into the group named after it", async () => {
    const founder = await openTab()
    await waitForPrompt(founder.id)
    const second = await manager.splitTab({ paneId: founder.id })
    await waitForPrompt(second.id)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    const group = await sessionGroup(second.tmuxSession)
    expect(group).not.toBe('')
    const founderWindow = await adapter.windowIdOf(founder.tmuxSession)
    expect(founderWindow).toMatch(/^@\d+$/)

    const exitEvent = waitForExitEvent(founder.id)
    await run('tmux', [
      '-L', SOCKET,
      'kill-session', '-t', `=${founder.tmuxSession}`, ';', 'kill-window', '-t', founderWindow,
    ])
    await exitEvent
    await expect(adapter.hasSession(founder.tmuxSession)).resolves.toBe(false)

    // No cols/rows anywhere: none were passed, and `lastGeometry` holds
    // nothing for a tab nothing has resized. So this restart is unsized, which
    // is what the window-size assertion below is here to hold.
    const restarted = await invoke<TabDescriptor>(CHANNELS.restartTab, { tab: founder })

    // Polled for the same reason as in the test above.
    await expect.poll(() => adapter.hasSession(restarted.tmuxSession), { timeout: 8000 }).toBe(true)
    expect(await sessionGroup(restarted.tmuxSession)).toBe(group)
    expect(await sessionGroup(second.tmuxSession)).toBe(group)
    const restartedWindow = await adapter.windowIdOf(restarted.tmuxSession)
    const siblingWindow = await adapter.windowIdOf(second.tmuxSession)
    expect(restartedWindow).toMatch(/^@\d+$/)
    expect(siblingWindow).toMatch(/^@\d+$/)
    expect(restartedWindow).not.toBe(siblingWindow)
    // Nobody measured this pane, so nothing may drive its window to a size.
    // Asserted on the OPTION, which is the only reading that can fail: forcing
    // `manual` and resizing to the default lands the window at exactly the
    // 80x24 the client attaches at anyway, so `windowSize()` reads the same
    // either way and could not catch it. Unset here means the window inherits
    // the global `latest` and follows its own client.
    expect(await windowSizeOption(restartedWindow)).toBe('')
  })

  // A tab that dies WHOLE — two `claude` sessions ending is ordinary, not
  // exotic — and is then restarted one pane at a time. The first pane back has
  // nothing to rejoin and is ungrouped by definition; an empty `session_group`
  // is invisible to a group-name match, so without the second half of
  // `liveGroupOf` the second pane finds nothing either and the tab comes back
  // as two. That happens with a perfectly good tab id — knowing which tab the
  // pane was in is necessary and not sufficient.
  it('restarts both panes of a tab that died whole back into one group', async () => {
    const founder = await openTab()
    await waitForPrompt(founder.id)
    const second = await manager.splitTab({ paneId: founder.id })
    await waitForPrompt(second.id)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    const founderWindow = await adapter.windowIdOf(founder.tmuxSession)
    const secondWindow = await adapter.windowIdOf(second.tmuxSession)
    expect(founderWindow).toMatch(/^@\d+$/)
    expect(secondWindow).toMatch(/^@\d+$/)

    const founderExit = waitForExitEvent(founder.id)
    const secondExit = waitForExitEvent(second.id)
    // The sibling first, session then window as the hook does it, while the
    // founder is still alive to keep the server up.
    await run('tmux', [
      '-L', SOCKET,
      'kill-session', '-t', `=${second.tmuxSession}`, ';', 'kill-window', '-t', secondWindow,
    ])
    // Then the founder, now the last session on this socket. No chained
    // `kill-window` here: killing the last session takes the server with it,
    // so the hook's second command would have nothing to talk to — measured,
    // `kill-session … ; kill-window -t @0` on a lone session prints "no
    // current target" and exits 1. There is nothing left to reap either; the
    // window went with the server.
    await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${founder.tmuxSession}`])
    await founderExit
    await secondExit
    await expect(adapter.hasSession(founder.tmuxSession)).resolves.toBe(false)
    await expect(adapter.hasSession(second.tmuxSession)).resolves.toBe(false)

    const backFirst = await invoke<TabDescriptor>(CHANNELS.restartTab, { tab: founder })
    await expect.poll(() => adapter.hasSession(backFirst.tmuxSession), { timeout: 8000 }).toBe(true)
    // Ungrouped, and correctly so: there was nothing left of the tab to join.
    // Asserted rather than assumed, because it is the precondition the second
    // restart has to cope with — if this ever came back grouped, the test
    // below would be exercising the ordinary path instead of this one.
    expect(await sessionGroup(backFirst.tmuxSession)).toBe('')

    const backSecond = await invoke<TabDescriptor>(CHANNELS.restartTab, { tab: second })
    await expect.poll(() => adapter.hasSession(backSecond.tmuxSession), { timeout: 8000 }).toBe(true)

    const group = await sessionGroup(backSecond.tmuxSession)
    expect(group).not.toBe('')
    expect(await sessionGroup(backFirst.tmuxSession)).toBe(group)
    // And it is this TAB's group, not merely some group the two share: a group
    // takes the name of the session it was created against, so re-forming it
    // through the founder gives back a name whose id half is the tab id.
    expect(group).toBe(founder.tmuxSession)

    const firstWindow = await adapter.windowIdOf(backFirst.tmuxSession)
    const secondBackWindow = await adapter.windowIdOf(backSecond.tmuxSession)
    expect(firstWindow).toMatch(/^@\d+$/)
    expect(secondBackWindow).toMatch(/^@\d+$/)
    expect(secondBackWindow).not.toBe(firstWindow)
  })

  // The population main has no other source for, and in real use the largest
  // one: a pane adopted from a PREVIOUS run. The manager below never created
  // these panes and never split them — the only thing that can know which tab
  // the adopted pane belongs to is the reconcile that grouped it, and only if
  // it hands that on. A version of this change that records the fact at
  // creation and skips the hand-off passes every other test in this file.
  it('restarts a pane adopted from a previous run back into its tab group', async () => {
    const founder = await openTab()
    await waitForPrompt(founder.id)
    const second = await manager.splitTab({ paneId: founder.id })
    await waitForPrompt(second.id)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    const group = await sessionGroup(founder.tmuxSession)
    expect(group).not.toBe('')
    expect(await sessionGroup(second.tmuxSession)).toBe(group)

    // Quit, then relaunch. Every client goes and both tmux sessions stay;
    // `useManager` throws the manager that made these panes away along with
    // everything it remembers and re-registers the handlers against a new one.
    // That is what makes the panes below adopted rather than recalled.
    manager.detachAll()
    await settle(500)
    useManager()

    const restored = await restoreTabs()
    expect(restored.panes.map((pane) => pane.id).sort()).toEqual([founder.id, second.id].sort())
    const adopted = restored.panes.find((pane) => pane.id === second.id)
    // Thrown rather than expected: everything below indexes into this, and
    // `undefined` would fail them for the wrong reason.
    if (!adopted) throw new Error(`restore did not bring back ${second.id}`)
    // Waited for, and this is not belt and braces: `manager.open()` returns as
    // soon as the client is SPAWNED, and that client's `new-session -A` may not
    // have run yet. Killing the session in that window leaves the client to
    // CREATE one under the same name — measured here: an ungrouped session,
    // alive and attached, and no exit event at all, which is a green pane on a
    // red assertion's behalf. The prompt is proof the attach has landed.
    await waitForPrompt(adopted.id)
    const adoptedWindow = await adapter.windowIdOf(adopted.tmuxSession)
    expect(adoptedWindow).toMatch(/^@\d+$/)

    // The death hook's own two commands, in its order — see the sibling test
    // above.
    const exitEvent = waitForExitEvent(adopted.id)
    await run('tmux', [
      '-L', SOCKET,
      'kill-session', '-t', `=${adopted.tmuxSession}`, ';', 'kill-window', '-t', adoptedWindow,
    ])
    await exitEvent
    await expect(adapter.hasSession(adopted.tmuxSession)).resolves.toBe(false)

    const restarted = await invoke<TabDescriptor>(CHANNELS.restartTab, { tab: adopted })

    await expect.poll(() => adapter.hasSession(restarted.tmuxSession), { timeout: 8000 }).toBe(true)
    // The group this tab had before the relaunch, read back for both panes and
    // asserted non-empty above — a group name survives a quit because the
    // sessions in it do.
    expect(await sessionGroup(restarted.tmuxSession)).toBe(group)
    expect(await sessionGroup(founder.tmuxSession)).toBe(group)
    const restartedWindow = await adapter.windowIdOf(restarted.tmuxSession)
    const siblingWindow = await adapter.windowIdOf(founder.tmuxSession)
    expect(restartedWindow).toMatch(/^@\d+$/)
    expect(siblingWindow).toMatch(/^@\d+$/)
    expect(restartedWindow).not.toBe(siblingWindow)
  })

  // The third case in `reopenInTab`, and the one every ordinary tab takes:
  // nothing of this tab is left in tmux, so there is no group to join and
  // `new-session -A` is right. Here to hold that a manager which now always has
  // an answer for "which tab was this pane in" still creates an UNGROUPED
  // session when that answer is the pane's own id.
  it('restarts a one-pane tab with no group to rejoin', async () => {
    const tab = await openTab()
    await waitForPrompt(tab.id)
    const adapter = new TmuxAdapter({ socket: SOCKET })
    // A tab that has never been split is a group of one, which tmux reports as
    // no group at all. Asserted so the reading after the restart means
    // something: it is the state being preserved, not merely the expected one.
    expect(await sessionGroup(tab.tmuxSession)).toBe('')

    const exitEvent = waitForExitEvent(tab.id)
    await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${tab.tmuxSession}`])
    await exitEvent
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(false)

    const restarted = await invoke<TabDescriptor>(CHANNELS.restartTab, { tab })

    expect(restarted.tmuxSession).toBe(tab.tmuxSession)
    // Alive first. `sessionGroup` answers `''` for a session tmux does not
    // have as readily as for one in no group, so without this the assertion
    // below would pass on a restart that created nothing at all.
    await expect.poll(() => adapter.hasSession(restarted.tmuxSession), { timeout: 8000 }).toBe(true)
    expect(await sessionGroup(restarted.tmuxSession)).toBe('')
  })
})

/**
 * Task 2d. A tab whose panes have ALL died has nothing left in tmux to rejoin,
 * and no one-line way back: tmux cannot move a live session into a group after
 * creation, and a group takes the name of the session `new-session -t` targets
 * — so such a tab can only regain a group by naming it after whichever pane
 * comes back first. The founder-first test above hides that, because the name
 * it lands on is the one the tab already had.
 *
 * Sibling-first is the same tab re-forming under a NEW group name, and it is
 * the case neither half of `liveGroupOf` could reach: the group-name match has
 * no group to look at, and the founder's own session — the only name the second
 * half matches — is exactly the one that is still dead. Before this the second
 * pane back found nothing to join and came back ungrouped too: two ungrouped
 * sessions where a split tab was, which the next restore reads as two tabs.
 * That is finding I4's harm verbatim, on the path the I4 fix left open.
 *
 * So the tab's identity is split from its tmux group: `TabRow.id` is permanent
 * and is what the renderer keys its container on, and `TabRow.groupId` carries
 * whichever group the tab is in now.
 */
describe('a tab that re-founds', () => {
  /**
   * A split tab whose panes have both died, with nothing of it left in tmux
   * and nothing of it left on disk.
   *
   * Split through `CHANNELS.splitPane` rather than `manager.splitTab` so a tab
   * row is actually written — the point being that both deaths then take it
   * away again. The founder is killed last because killing the last session on
   * a socket takes the server with it, which would leave the chained
   * `kill-window` nothing to talk to.
   */
  async function deadSplitTab(): Promise<{ founder: TabDescriptor; second: TabDescriptor }> {
    const founder = await invoke<TabDescriptor>(CHANNELS.open, {
      projectSlug: 'lumio',
      cwd: tmpdir(),
    })
    await waitForPrompt(founder.id)
    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id,
      dir: 'row',
      cols: 100,
      rows: 30,
    })
    // Counted before anything indexes into it: `[][1]` is undefined, and every
    // assertion below would then fail for the wrong reason.
    expect(shape.panes).toHaveLength(2)
    const second = shape.panes[1]
    await waitForPrompt(second.id)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    const secondWindow = await adapter.windowIdOf(second.tmuxSession)
    expect(secondWindow).toMatch(/^@\d+$/)

    // A session of tmux's own, so that killing both panes does not take the
    // server down with them — the last kill on a socket ends the server.
    //
    // Measured, and the measurement is all this rests on: without this line
    // one of the two pane rows is still on disk when the deaths have landed,
    // which one is a race, and `waitForSavedIds` below times out on it. The
    // CAUSE is not identified and is deliberately not guessed at here. The
    // obvious explanation — the exit handler cannot tell whether the session
    // survived and falls back to "alive" — is wrong for the two shapes a
    // reader would check first: `adapter.hasSession` answers **false** for
    // both `no server running` and `error connecting to … no such file or
    // directory` (`isNoServer`, folded into `isNoSuchSession`), so
    // `sessionSurvived` never reaches its `catch` and `forgetTab` does run.
    // Something else about a server going down mid-teardown does it.
    //
    // The keeper's own name decodes to nothing, so no lookup in main can see
    // it: `findOrphans` filters on `isPrcliSession`, and every match in
    // `memberOfTab` and `panesOfTab` goes through `decodeSessionName`.
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'keeper'])

    const founderExit = waitForExitEvent(founder.id)
    const secondExit = waitForExitEvent(second.id)
    // The death hook's own two commands, in its order — see the restartTab
    // tests above. This manager has no death reporter, so nothing else would.
    await run('tmux', [
      '-L', SOCKET,
      'kill-session', '-t', `=${second.tmuxSession}`, ';', 'kill-window', '-t', secondWindow,
    ])
    // No chained `kill-window` on this one: the sibling's window went with the
    // command above, so the founder's is the last window its group's window
    // list holds and tmux reaps it with the session — measured, `kill-window
    // -t @0` right after reports "can't find window: @0" and exits 1.
    await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${founder.tmuxSession}`])
    await founderExit
    await secondExit
    await expect(adapter.hasSession(founder.tmuxSession)).resolves.toBe(false)
    await expect(adapter.hasSession(second.tmuxSession)).resolves.toBe(false)

    // Waited for, not assumed: `forgetTab` runs off the exit event and takes
    // its own turn in the config queue, so a later read of the file would
    // otherwise race a write that is still coming.
    await waitForSavedIds(store, [])
    return { founder, second }
  }

  it('brings a wholly dead split back into one group when the SIBLING restarts first', async () => {
    const { founder, second } = await deadSplitTab()
    const adapter = new TmuxAdapter({ socket: SOCKET })

    const backFirst = await invoke<TabDescriptor>(CHANNELS.restartTab, { tab: second })
    await expect.poll(() => adapter.hasSession(backFirst.tmuxSession), { timeout: 8000 }).toBe(true)
    // Ungrouped, and correctly so — there was nothing left of the tab to join.
    // Asserted rather than assumed, because it is the precondition the second
    // restart has to cope with: if this ever came back grouped, the assertions
    // below would be exercising the ordinary path instead of this one.
    expect(await sessionGroup(backFirst.tmuxSession)).toBe('')

    const backSecond = await invoke<TabDescriptor>(CHANNELS.restartTab, { tab: founder })
    await expect.poll(() => adapter.hasSession(backSecond.tmuxSession), { timeout: 8000 }).toBe(true)

    // Read back from tmux for each, with the trailing colon `sessionGroup`
    // documents, and non-empty before the two are compared — `''` is also what
    // a lookup against a session tmux does not have returns, and two failed
    // lookups agree perfectly.
    const group = await sessionGroup(backSecond.tmuxSession)
    expect(group).not.toBe('')
    expect(await sessionGroup(backFirst.tmuxSession)).toBe(group)
    // Named after the pane that came back FIRST, which is the whole of what
    // re-founding means: the founder's own session name is not a target tmux
    // has any more, so the group cannot be given the name it used to have.
    expect(group).toBe(second.tmuxSession)

    // And each pane bound to a window of its own. A member that attaches
    // before it is bound lands on a sibling's window, and two xterms then
    // render one pane.
    const firstWindow = await adapter.windowIdOf(backFirst.tmuxSession)
    const secondWindow = await adapter.windowIdOf(backSecond.tmuxSession)
    expect(firstWindow).toMatch(/^@\d+$/)
    expect(secondWindow).toMatch(/^@\d+$/)
    expect(secondWindow).not.toBe(firstWindow)
  })

  /** Both panes back, sibling first — so the tab is live again under a new group. */
  async function refoundedTab(): Promise<{ founder: TabDescriptor; second: TabDescriptor }> {
    const { founder, second } = await deadSplitTab()
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const backSibling = await invoke<TabDescriptor>(CHANNELS.restartTab, {
      tab: second,
      cols: 100,
      rows: 30,
    })
    await expect
      .poll(() => adapter.hasSession(backSibling.tmuxSession), { timeout: 8000 })
      .toBe(true)
    const backFounder = await invoke<TabDescriptor>(CHANNELS.restartTab, {
      tab: founder,
      cols: 100,
      rows: 30,
    })
    await expect
      .poll(() => adapter.hasSession(backFounder.tmuxSession), { timeout: 8000 })
      .toBe(true)
    // The group they share is the sibling's, asserted here so the identity
    // assertions in each test below are about a tab that really has re-founded.
    const group = await sessionGroup(backFounder.tmuxSession)
    expect(group).toBe(second.tmuxSession)
    await waitForPrompt(backFounder.id)
    return { founder, second }
  }

  it('writes the tab row under its original id, and the new group beside it', async () => {
    const { founder, second } = await refoundedTab()
    // Disk remembers nothing of this tab by now — `forgetTab` dropped each
    // pane row as it died, and `store.read()` drops a tab row whose kids have
    // all gone. So what identity the tab comes back under is decided entirely
    // by main's live memory of it, which is the thing under test.
    expect((await written()).tabs).toHaveLength(0)

    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id,
      dir: 'row',
      cols: 100,
      rows: 30,
    })
    expect(shape.panes).toHaveLength(3)
    const third = shape.panes[1]
    await waitForPrompt(third.id)

    // What the renderer is handed. It keys each tab's container on this id and
    // `Terminal.tsx` disposes the xterm on unmount, so a row arriving under the
    // new group's id would unmount the tab and take every scrollback in it —
    // including the two the user just restarted.
    expect(shape.tabs).toHaveLength(1)
    expect(shape.tabs[0].id).toBe(founder.id)
    expect(shape.tabs[0].groupId).toBe(second.id)

    // Raw, because these are the assertions `store.read()` would repair: it
    // rescales every ratio array by its own total and defaults a missing
    // `groupId` to the row's id, so a row written with shares summing to 0.5,
    // or with no group id at all, reads back through it looking perfect.
    const config = await written()
    expect(config.tabs).toHaveLength(1)
    const row = config.tabs[0]
    expect(row.id).toBe(founder.id)
    expect(row.groupId).toBe(second.id)
    expect(row.layout.kids).toEqual([founder.id, third.id, second.id])
    expect(row.layout.ratio).toHaveLength(3)
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // The one way a tab row outlives the tab it describes, and so the one way a
  // saved row can be sitting there pointing at a group that no longer exists:
  // `forgetTab` runs off an exit event, and a pane whose client had already
  // detached sends none when its session is killed from outside. Its row stays,
  // the tab row keeps it as a kid, and both survive the visible pane's death.
  //
  // Without the correction below, that row would name the old group for good —
  // and never match this tab again on any future restore, which is the layout
  // lost permanently rather than for one run.
  it('corrects a saved row that outlived its group when the tab re-founds', async () => {
    const founder = await invoke<TabDescriptor>(CHANNELS.open, {
      projectSlug: 'lumio',
      cwd: tmpdir(),
    })
    await waitForPrompt(founder.id)
    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id,
      dir: 'row',
      cols: 100,
      rows: 30,
    })
    expect(shape.panes).toHaveLength(2)
    const second = shape.panes[1]
    await waitForPrompt(second.id)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    const secondWindow = await adapter.windowIdOf(second.tmuxSession)
    expect(secondWindow).toMatch(/^@\d+$/)
    // Keeps the server up once both panes are gone; see `deadSplitTab`.
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'keeper'])

    // The founder's client goes first, deliberately — that is what makes its
    // death invisible to main.
    detachTab(founder.id)
    await settle(500)
    await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${founder.tmuxSession}`])

    // No chained `kill-window`: this is the last session of the tab's group,
    // and tmux reaps a window list nothing holds any more — measured, the
    // chained form reports "can't find window" and exits 1.
    const exitEvent = waitForExitEvent(second.id)
    await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${second.tmuxSession}`])
    await exitEvent
    await expect(adapter.hasSession(founder.tmuxSession)).resolves.toBe(false)
    await expect(adapter.hasSession(second.tmuxSession)).resolves.toBe(false)
    await waitForSavedIds(store, [founder.id])

    // The precondition, asserted rather than assumed: a row for a tab with no
    // live pane at all, still naming the group the tab used to be in.
    const before = await written()
    expect(before.tabs).toHaveLength(1)
    expect(before.tabs[0].id).toBe(founder.id)
    expect(before.tabs[0].groupId).toBe(founder.id)

    const back = await invoke<TabDescriptor>(CHANNELS.restartTab, { tab: second })
    await expect.poll(() => adapter.hasSession(back.tmuxSession), { timeout: 8000 }).toBe(true)
    // Ungrouped: there was nothing left to rejoin, so this pane is the tab's
    // new founder and its own session is the group any sibling will join.
    expect(await sessionGroup(back.tmuxSession)).toBe('')

    const after = await written()
    expect(after.tabs).toHaveLength(1)
    // The tab is the same tab — the renderer is still drawing it, with the
    // founder's tombstone in it — and it is now in a different group.
    expect(after.tabs[0].id).toBe(founder.id)
    expect(after.tabs[0].groupId).toBe(second.id)
  })

  it('finds the re-founded tab again on restore, still under its original id', async () => {
    const { founder, second } = await refoundedTab()
    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id,
      dir: 'col',
      cols: 100,
      rows: 30,
    })
    expect(shape.panes).toHaveLength(3)
    const third = shape.panes[1]
    await waitForPrompt(third.id)

    // Quit and relaunch: every client goes, the three tmux sessions stay, and
    // the manager that remembered this tab is thrown away with everything in
    // it. From here the saved row is the only thing that can say what this
    // tab's identity was — matched by the group it is in NOW, which is not the
    // id that row is keyed by.
    manager.detachAll()
    await settle(500)
    useManager()

    const restored = await restoreTabs()
    expect(restored.panes).toHaveLength(3)
    expect(restored.tabs).toHaveLength(1)
    expect(restored.tabs[0].id).toBe(founder.id)
    expect(restored.tabs[0].groupId).toBe(second.id)
    // The layout survived with it, in the order and on the axis the split set.
    expect(restored.tabs[0].layout.kids).toEqual([founder.id, third.id, second.id])
    expect(restored.tabs[0].layout.dir).toBe('col')

    const config = await written()
    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0].id).toBe(founder.id)
    expect(config.tabs[0].groupId).toBe(second.id)
    expect(config.tabs[0].layout.ratio).toHaveLength(3)
    expect(config.tabs[0].layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)

    // And the new manager was told the STABLE id for each adopted pane, not
    // the group's. It is what every row this run writes will be keyed by, so a
    // pane adopted under the group id would hand the renderer a new tab the
    // first time one of these panes was split or closed.
    expect(manager.tabIdOf(founder.id)).toBe(founder.id)
    expect(manager.tabIdOf(second.id)).toBe(founder.id)
    expect(manager.tabIdOf(third.id)).toBe(founder.id)
  })
})

describe('splitPane and closePane', () => {
  /** A tab of two panes, made the way the UI now makes one. */
  async function splitOnce(
    dir: 'row' | 'col' = 'row',
  ): Promise<{ founder: TabDescriptor; second: TabDescriptor; shape: TabShape }> {
    const founder = await invoke<TabDescriptor>(CHANNELS.open, {
      projectSlug: 'lumio',
      cwd: tmpdir(),
    })
    await waitForPrompt(founder.id)
    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id,
      dir,
      cols: 100,
      rows: 30,
    })
    // Counted before anything indexes into it. `[].every` is true and `[][1]`
    // is undefined, so a reply that made no pane at all would otherwise sail
    // through every assertion below it.
    expect(shape.panes).toHaveLength(2)
    const second = shape.panes[1]
    await waitForPrompt(second.id)
    return { founder, second, shape }
  }

  it('splits a pane into its tab and writes the tab row that lays them out', async () => {
    const { founder, second, shape } = await splitOnce('col')
    expect(second.id).not.toBe(founder.id)
    expect(shape.panes[0].id).toBe(founder.id)

    // One group, read back from tmux for each pane and asserted non-empty
    // first: `display-message` exits 0 with empty stdout for a session it does
    // not have, so two failed lookups agree perfectly.
    const group = await sessionGroup(founder.tmuxSession)
    expect(group).not.toBe('')
    expect(await sessionGroup(second.tmuxSession)).toBe(group)

    // Each pane's OWN id, read out of each pane's own running PROCESS — which
    // is where the hook script reads it from, and a different object from the
    // session environment table asserted below. Two panes sharing one value is
    // two panes' status collapsed onto one dot.
    expect(await paneEnvTabId(second.id)).toBe(second.id)
    expect(await paneEnvTabId(founder.id)).toBe(founder.id)

    // The table as well, because `addMember` sets the variable in both places
    // deliberately and a reattach reads this one. Neither assertion stands in
    // for the other: `-e` on `new-window` reaches only the process, `-e` on
    // `new-session -t <group>` reaches only the table.
    await expect
      .poll(() => sessionEnv(founder.tmuxSession, 'PRCLI_TAB_ID'), { timeout: 10_000 })
      .toBe(`PRCLI_TAB_ID=${founder.id}`)
    await expect
      .poll(() => sessionEnv(second.tmuxSession, 'PRCLI_TAB_ID'), { timeout: 10_000 })
      .toBe(`PRCLI_TAB_ID=${second.id}`)

    // A window each, bound before either client attached. A member that
    // attaches onto a sibling's window leaves two xterms rendering one pane.
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const founderWindow = await adapter.windowIdOf(founder.tmuxSession)
    const secondWindow = await adapter.windowIdOf(second.tmuxSession)
    expect(founderWindow).toMatch(/^@\d+$/)
    expect(secondWindow).toMatch(/^@\d+$/)
    expect(secondWindow).not.toBe(founderWindow)
    // The size the request carried, not the 80x24 `splitTab` would have
    // defaulted to had `splitPane` let an unmeasured request through.
    await expect.poll(() => windowSize(second.tmuxSession), { timeout: 8000 }).toBe('100x30')

    // The file, raw. Nothing before this task wrote a multi-pane tab row from a
    // user action at all, so every field here is new.
    const config = await written()
    expect(config.panes.map((pane) => pane.id)).toEqual([founder.id, second.id])
    expect(config.tabs).toHaveLength(1)
    const row = config.tabs[0]
    // The TAB's id, which is the id of the pane that founded it.
    expect(row.id).toBe(founder.id)
    // And its group, which is the same id until this tab ever re-founds.
    expect(row.groupId).toBe(founder.id)
    expect(row.activePaneId).toBe(second.id)
    expect(row.layout.kids).toEqual([founder.id, second.id])
    // The FIRST split of this tab, which is the only one the requested axis
    // decides — see the two tests below.
    expect(row.layout.dir).toBe('col')
    expect(row.layout.ratio).toHaveLength(2)
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
    // And the reply is the row that was written, not a second opinion about it.
    expect(shape.tabs).toEqual([row])
  })

  // The ruling: a tab's axis is set by the split that creates it, and a later
  // split adds a pane along that axis rather than re-orienting every pane in
  // the tab — which with terminals means reflowing them and resizing their
  // real tmux sessions, a cost paid by panes the user did not act on.
  it("adds a pane along an already-split tab's axis rather than re-orienting it", async () => {
    const { founder } = await splitOnce('row')

    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id,
      dir: 'col',
      cols: 100,
      rows: 30,
    })
    expect(shape.panes).toHaveLength(3)
    await waitForPrompt(shape.panes[1].id)

    const config = await written()
    expect(config.tabs).toHaveLength(1)
    // The axis the tab was created with, not the one just asked for.
    expect(config.tabs[0].layout.dir).toBe('row')
    // And the pane did land — this is "ignored the direction", not "ignored
    // the split", which was the other candidate and was rejected.
    expect(config.tabs[0].layout.kids).toHaveLength(3)
    expect(config.tabs[0].layout.kids).toContain(shape.panes[1].id)
  })

  // The gate is "already split", not "a row exists". Restore writes a row for
  // every tab it brings back, one-pane tabs included, so keying off the row
  // alone would make a direction request a no-op on any tab relaunched since it
  // was opened. Reached here without a relaunch: a tab split and then closed
  // back down to one pane has a row and no axis on screen, which is the same
  // state.
  it('lets a tab that is down to one pane choose its axis again', async () => {
    const { founder, second } = await splitOnce('row')
    await invoke<TabShape>(CHANNELS.closePane, second.id)

    // The precondition, asserted rather than assumed: a row survives, it says
    // `row`, and it holds one pane.
    const before = await written()
    expect(before.tabs).toHaveLength(1)
    expect(before.tabs[0].layout.dir).toBe('row')
    expect(before.tabs[0].layout.kids).toEqual([founder.id])

    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id,
      dir: 'col',
      cols: 100,
      rows: 30,
    })
    expect(shape.panes).toHaveLength(2)
    await waitForPrompt(shape.panes[1].id)

    const after = await written()
    expect(after.tabs).toHaveLength(1)
    expect(after.tabs[0].layout.dir).toBe('col')
    expect(after.tabs[0].layout.kids).toHaveLength(2)
  })

  // The insertion point, which is the one thing about `kids` that a two-pane
  // split cannot show: with one sibling, "after it" and "at the end" are the
  // same position.
  it('inserts a new pane after the sibling it was split from, not at the end', async () => {
    const { founder, second } = await splitOnce()

    const again = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id,
      dir: 'row',
      cols: 100,
      rows: 30,
    })
    expect(again.panes).toHaveLength(3)
    const third = again.panes[1]
    await waitForPrompt(third.id)
    expect(third.id).not.toBe(founder.id)
    expect(third.id).not.toBe(second.id)

    const config = await written()
    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0].layout.kids).toEqual([founder.id, third.id, second.id])
    expect(config.tabs[0].layout.ratio).toHaveLength(3)
    expect(config.tabs[0].layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // The ruling this handler exists to enforce: `splitTab` defaults an absent
  // size to 80x24 and then resizes the new window to it, so "do not pass a
  // default" can only be honoured by refusing the call.
  it('refuses to split a pane the renderer has not measured', async () => {
    const founder = await invoke<TabDescriptor>(CHANNELS.open, {
      projectSlug: 'lumio',
      cwd: tmpdir(),
    })
    await waitForPrompt(founder.id)

    await expect(
      invoke(CHANNELS.splitPane, { paneId: founder.id, dir: 'row', cols: 0, rows: 0 }),
    ).rejects.toThrow(/not measured/i)

    // Refused before anything was created, not after. A tab that has never been
    // split is a group of one, which tmux reports as no group at all.
    expect(await sessionGroup(founder.tmuxSession)).toBe('')
    const config = await written()
    expect(config.panes.map((pane) => pane.id)).toEqual([founder.id])
    expect(config.tabs).toEqual([])
  })

  it('closes one pane of two and leaves the sibling running in its own window', async () => {
    const { founder, second } = await splitOnce()
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const founderWindow = await adapter.windowIdOf(founder.tmuxSession)
    expect(founderWindow).toMatch(/^@\d+$/)

    const shape = await invoke<TabShape>(CHANNELS.closePane, second.id)
    expect(shape.panes.map((pane) => pane.id)).toEqual([founder.id])
    expect(shape.tabs).toHaveLength(1)

    await expect.poll(() => adapter.hasSession(second.tmuxSession), { timeout: 8000 }).toBe(false)
    // The sibling's session AND the window its shell lives in. `manager.kill`
    // reaps the closed pane's window too, and a pane that reports its
    // sibling's would take the other shell down with it.
    expect(await adapter.hasSession(founder.tmuxSession)).toBe(true)
    expect(await adapter.windowIdOf(founder.tmuxSession)).toBe(founderWindow)

    // Raw, because this is the assertion `store.read()` would repair: it
    // rescales whatever ratio array it finds by that array's own total, so a
    // `closePane` that dropped the kid and kept `[0.5]` reads back as `[1]`.
    const config = await written()
    expect(config.panes.map((pane) => pane.id)).toEqual([founder.id])
    expect(config.tabs).toHaveLength(1)
    const row = config.tabs[0]
    expect(row.layout.kids).toEqual([founder.id])
    expect(row.layout.ratio).toHaveLength(1)
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
    // Selection followed the pane that went, rather than naming it still.
    expect(row.activePaneId).toBe(founder.id)
  })

  /**
   * A split tab whose sibling has died and been restarted — so it is running,
   * back in its tmux group and back in `config.panes`, and claimed by no tab
   * row at all.
   *
   * That last part is the state both tests below are about, and it is not
   * contrived: `forgetTab` drops a dead pane's row, the next `store.read()`
   * drops it from the kids, and `restartTab` writes the pane back without
   * putting it back in the layout. Nothing repairs it before the next restore.
   */
  // Keyed by role ('founder'/'second'), not by pane id: the caller cannot name
  // the ids `splitOnce` is about to mint before it runs. Remapped onto the
  // real ids the moment they exist, below — the message the wire actually
  // carries is named by pane id like every other one in this file.
  async function splitThenRestartSibling(shares?: Record<string, number>): Promise<{
    founder: TabDescriptor
    second: TabDescriptor
  }> {
    const { founder, second } = await splitOnce()
    // Dragged before the death, when a caller wants the two panes at a
    // deliberate size rather than the even one a split leaves them at. The
    // same listener and the same settle the drag tests above use.
    if (shares) {
      const named = { [founder.id]: shares.founder, [second.id]: shares.second }
      ipc.listeners.get(CHANNELS.setLayout)?.(null as never, founder.id as never, named as never)
      await settle(200)
    }
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const secondWindow = await adapter.windowIdOf(second.tmuxSession)
    expect(secondWindow).toMatch(/^@\d+$/)

    // The death hook's own two commands, in its order — see the restartTab
    // tests above. This manager has no death reporter, so nothing else would.
    const exitEvent = waitForExitEvent(second.id)
    await run('tmux', [
      '-L', SOCKET,
      'kill-session', '-t', `=${second.tmuxSession}`, ';', 'kill-window', '-t', secondWindow,
    ])
    await exitEvent
    await expect(adapter.hasSession(second.tmuxSession)).resolves.toBe(false)

    const restarted = await invoke<TabDescriptor>(CHANNELS.restartTab, {
      tab: second,
      cols: 100,
      rows: 30,
    })
    await expect.poll(() => adapter.hasSession(restarted.tmuxSession), { timeout: 8000 }).toBe(true)

    // The precondition, asserted rather than assumed: the restarted pane is
    // back on disk and NO row claims it. If this ever stopped holding, both
    // tests below would be exercising the ordinary path instead of this one.
    const before = await written()
    expect(before.panes.map((pane) => pane.id).sort()).toEqual([founder.id, second.id].sort())
    expect(before.tabs).toHaveLength(1)
    expect(before.tabs[0].layout.kids).toEqual([founder.id])

    return { founder, second }
  }

  // Building `kids` from the saved row alone drops a LIVE pane from both the
  // file and the reply, which is the one thing `TabShape` promises not to do.
  // Reachable the moment both affordances are wired: restart a dead pane in a
  // split tab, then split again.
  it('keeps a restarted pane in the tab when a sibling is split', async () => {
    const { founder, second } = await splitThenRestartSibling()

    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id,
      dir: 'row',
      cols: 100,
      rows: 30,
    })
    expect(shape.panes).toHaveLength(3)
    const third = shape.panes[1]
    await waitForPrompt(third.id)
    expect(shape.panes.map((pane) => pane.id)).toEqual([founder.id, third.id, second.id])

    const after = await written()
    expect(after.tabs).toHaveLength(1)
    expect(after.tabs[0].layout.kids).toEqual([founder.id, third.id, second.id])
    expect(after.tabs[0].layout.ratio).toHaveLength(3)
    expect(after.tabs[0].layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // The same union in `closePane`, and it needs its own stale row: a split
  // repairs the row on its way past, so a close that follows one is no longer
  // testing this. Closing the FOUNDER while the row still claims only the
  // founder is the sharpest form of it — without the union the row's last kid
  // goes, the tab is dropped as empty, and a running pane loses the tab it is
  // drawn in.
  it('keeps a restarted pane in the tab when the last claimed pane is closed', async () => {
    const { founder, second } = await splitThenRestartSibling()
    const adapter = new TmuxAdapter({ socket: SOCKET })

    const closed = await invoke<TabShape>(CHANNELS.closePane, founder.id)
    expect(closed.panes.map((pane) => pane.id)).toEqual([second.id])
    expect(closed.tabs).toHaveLength(1)
    expect(closed.tabs[0].layout.kids).toEqual([second.id])

    // The pane that had to survive really did, in tmux and not only in the
    // reply. Polled for the founder's death, asserted plainly for the sibling.
    await expect.poll(() => adapter.hasSession(founder.tmuxSession), { timeout: 8000 }).toBe(false)
    expect(await adapter.hasSession(second.tmuxSession)).toBe(true)

    const after = await written()
    expect(after.panes.map((pane) => pane.id)).toEqual([second.id])
    expect(after.tabs).toHaveLength(1)
    // The row keeps the dead FOUNDER's id, and that is right twice over: it is
    // the tab's permanent identity, which the renderer keys its container on,
    // and this tab is still in the group founded under that name — a group
    // keeps the name it was founded under, and restore resolves rows by the
    // group id. A row renamed after the survivor would stop matching the tab
    // AND unmount it. The one case where the two ids come apart is a tab whose
    // panes have ALL died and which re-founds; then only `groupId` moves.
    expect(after.tabs[0].id).toBe(founder.id)
    expect(after.tabs[0].layout.kids).toEqual([second.id])
    expect(after.tabs[0].layout.ratio).toHaveLength(1)
    expect(after.tabs[0].layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // `withTabRow` replaces a row where it stands rather than removing and
  // appending, because array order is the order the tab bar draws. Every other
  // test here has one tab, so nothing else exercises it — and a re-founding
  // rewrites a row's `groupId` through the same helper.
  it('leaves the other tabs where they are when one is split or closed', async () => {
    const first = await invoke<TabDescriptor>(CHANNELS.open, {
      projectSlug: 'lumio',
      cwd: tmpdir(),
    })
    await waitForPrompt(first.id)
    const other = await invoke<TabDescriptor>(CHANNELS.open, {
      projectSlug: 'lumio',
      cwd: tmpdir(),
    })
    await waitForPrompt(other.id)

    const size = { dir: 'row', cols: 100, rows: 30 } as const
    const firstSplit = await invoke<TabShape>(CHANNELS.splitPane, { paneId: first.id, ...size })
    expect(firstSplit.panes).toHaveLength(2)
    await waitForPrompt(firstSplit.panes[1].id)
    const otherSplit = await invoke<TabShape>(CHANNELS.splitPane, { paneId: other.id, ...size })
    expect(otherSplit.panes).toHaveLength(2)
    await waitForPrompt(otherSplit.panes[1].id)

    expect((await written()).tabs.map((row) => row.id)).toEqual([first.id, other.id])

    // Splitting the FIRST tab again must not send it behind the second.
    const again = await invoke<TabShape>(CHANNELS.splitPane, { paneId: first.id, ...size })
    expect(again.panes).toHaveLength(3)
    await waitForPrompt(again.panes[1].id)
    const afterSplit = await written()
    expect(afterSplit.tabs.map((row) => row.id)).toEqual([first.id, other.id])
    expect(afterSplit.tabs[0].layout.kids).toHaveLength(3)
    // And the neighbour's row is untouched by a split it had no part in.
    expect(afterSplit.tabs[1].layout.kids).toEqual(otherSplit.tabs[0].layout.kids)

    // Same both ways: closing a pane of the second tab leaves the first tab's
    // row where it was and as it was.
    await invoke<TabShape>(CHANNELS.closePane, otherSplit.panes[1].id)
    const afterClose = await written()
    expect(afterClose.tabs.map((row) => row.id)).toEqual([first.id, other.id])
    expect(afterClose.tabs[0].layout.kids).toEqual(afterSplit.tabs[0].layout.kids)
  })

  it('closes the tab when its last pane is closed', async () => {
    const { founder, second } = await splitOnce()
    const adapter = new TmuxAdapter({ socket: SOCKET })

    await invoke<TabShape>(CHANNELS.closePane, second.id)
    // Asserted before the last close, so the state that assertion is about is
    // the one this test set up: a tab down to one pane, with a row still on
    // disk. Without it, "no tab row afterwards" would also be satisfied by a
    // `closePane` that had written no row in the first place.
    const between = await written()
    expect(between.tabs).toHaveLength(1)
    expect(between.tabs[0].layout.kids).toEqual([founder.id])

    const shape = await invoke<TabShape>(CHANNELS.closePane, founder.id)
    expect(shape.panes).toEqual([])
    expect(shape.tabs).toEqual([])

    await expect.poll(() => adapter.hasSession(founder.tmuxSession), { timeout: 8000 }).toBe(false)
    expect(await adapter.hasSession(second.tmuxSession)).toBe(false)

    const config = await written()
    expect(config.panes).toEqual([])
    expect(config.tabs).toEqual([])
  })

  it('writes a dragged ratio to the tab row and leaves the panes alone', async () => {
    // `splitOnce` returns the FOUNDER, whose own id is the tab's id — there is
    // no `tabId` field on a `TabDescriptor`, and reaching for one is the
    // mistake this comment exists to stop.
    const { founder, second } = await splitOnce()
    const before = await written()
    expect(before.panes).toHaveLength(2)

    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.7, [second.id]: 0.3 } as never,
    )
    await settle(200)

    const after = await written()
    const row = after.tabs.find((candidate) => candidate.id === founder.id)
    expect(row).toBeDefined()
    expect(row?.layout.ratio).toEqual([0.7, 0.3])
    expect(row?.layout.kids).toEqual([founder.id, second.id])
    // A layout write must never touch existence.
    expect(after.panes.map((pane) => pane.id).sort()).toEqual(
      before.panes.map((pane) => pane.id).sort(),
    )
  })

  it('writes a drag on a tab holding a tombstone, which used to be dropped in silence', async () => {
    // CT-1's persistence half, end to end. `bbb` has died, so main's saved row
    // no longer names it while the renderer still draws it — the state in which
    // EVERY drag on this tab was silently discarded by the old length guard.
    const { founder, second } = await splitOnce()
    const third = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 100, rows: 30,
    })
    const middle = third.panes[1]
    await waitForPrompt(middle.id)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    const window = await adapter.windowIdOf(second.tmuxSession)
    expect(window).toMatch(/^@\d+$/)
    const exited = waitForExitEvent(second.id)
    await run('tmux', [
      '-L', SOCKET,
      'kill-session', '-t', `=${second.tmuxSession}`, ';', 'kill-window', '-t', window,
    ])
    await exited
    await expect.poll(() => written().then((c) => c.panes.length), { timeout: 8000 }).toBe(2)

    const before = await written()
    // The precondition, asserted rather than assumed: the row on disk names two
    // panes and the message names three.
    expect(before.tabs[0].layout.kids).toEqual([founder.id, middle.id])

    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.3, [middle.id]: 0.3, [second.id]: 0.4 } as never,
    )
    await settle(200)

    const after = await written()
    const row = after.tabs.find((candidate) => candidate.id === founder.id)
    expect(row?.layout.kids).toEqual([founder.id, middle.id])
    // The live kids held 0.6 of the tab between them, so the row that describes
    // only them is 0.5/0.5. Read from the raw file, not through `store.read()`,
    // which would rescale a wrong answer into a right-looking one.
    expect(row?.layout.ratio[0]).toBeCloseTo(0.5)
    expect(row?.layout.ratio[1]).toBeCloseTo(0.5)
    expect(after.panes.map((pane) => pane.id).sort()).toEqual(
      before.panes.map((pane) => pane.id).sort(),
    )
  })

  it('ignores a record naming a pane the tab does not have, and writes nothing', async () => {
    const { founder, second } = await splitOnce()
    const before = await written()
    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.5, [second.id]: 0.3, 'not-a-pane': 0.2 } as never,
    )
    await settle(200)
    const after = await written()
    expect(after.tabs[0].layout.ratio).toEqual(before.tabs[0].layout.ratio)
  })

  it('carves the new pane out of the pane being split, leaving others alone', async () => {
    const { founder, second } = await splitOnce()
    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.7, [second.id]: 0.3 } as never,
    )
    await settle(200)

    // Split the 30, which should become two 15s and leave the 70 untouched.
    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: second.id, dir: 'row', cols: 40, rows: 20,
    })
    await waitForPrompt(shape.panes[shape.panes.length - 1].id)
    const row = shape.tabs[0]
    expect(row.layout.kids).toHaveLength(3)
    const at = (id: string): number => row.layout.ratio[row.layout.kids.indexOf(id)]
    expect(at(founder.id)).toBeCloseTo(0.7)
    expect(at(second.id)).toBeCloseTo(0.15)
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // The reviewer's Critical, reproduced for real: `carveRatio`'s
  // `tests/unit/carveRatio.test.ts` covers the arithmetic in isolation; this
  // proves the wiring around it — that a pane restarted after its sibling's
  // row entry went at its death is genuinely detected as "unclaimed" through
  // live tmux and `config.panes`, the way `splitThenRestartSibling` above
  // establishes, and that `splitPane` feeds it to `carveRatio` as such.
  //
  // Two assertions, not one, because a review round's own A/B found that the
  // obvious one is not enough. The RELATIVE proportion between the two known
  // panes (A and C, saved at 0.6:0.4) surviving B's dilution is a real,
  // worth-having property — but it turns out to hold no matter what share B
  // is given, correctly computed or not: A and C's own shares never read
  // B's value, so B only changes the common total everyone divides by, and
  // that total cancels out of a ratio taken between two panes that both
  // divide by it. A `splitPane` that dropped B's share to zero would still
  // pass that assertion. What actually catches it is checking B's OWN final
  // share is positive — see `carveRatio`'s doc comment for the full account
  // of why both checks are needed and neither alone is.
  it('dilutes every known share evenly when carving beside an unclaimed sibling, and keeps their relative sizes', async () => {
    const { founder, second } = await splitOnce() // A, B — kids [A, B]
    const split2 = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 100, rows: 30,
    })
    expect(split2.panes).toHaveLength(3)
    const third = split2.panes[1] // C, inserted after A: kids [A, C, B]
    await waitForPrompt(third.id)
    expect(split2.tabs[0].layout.kids).toEqual([founder.id, third.id, second.id])

    // A:C:B set to 0.3:0.2:0.5 — chosen so that once B's row entry is gone,
    // A and C rescale to exactly 0.6:0.4, a round pair that is easy to check.
    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.3, [third.id]: 0.2, [second.id]: 0.5 } as never,
    )
    await settle(200)

    // B dies and comes back the way `splitThenRestartSibling` above
    // establishes: running, back in `config.panes`, claimed by no row.
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const secondWindow = await adapter.windowIdOf(second.tmuxSession)
    expect(secondWindow).toMatch(/^@\d+$/)
    const exitEvent = waitForExitEvent(second.id)
    await run('tmux', [
      '-L', SOCKET,
      'kill-session', '-t', `=${second.tmuxSession}`, ';', 'kill-window', '-t', secondWindow,
    ])
    await exitEvent
    await expect(adapter.hasSession(second.tmuxSession)).resolves.toBe(false)
    const restarted = await invoke<TabDescriptor>(CHANNELS.restartTab, {
      tab: second, cols: 100, rows: 30,
    })
    await expect.poll(() => adapter.hasSession(restarted.tmuxSession), { timeout: 8000 }).toBe(true)

    // The precondition: A and C alone in the row, rescaled to 0.6/0.4, and B
    // back on disk but claimed by nothing.
    const before = await written()
    expect(before.panes.map((pane) => pane.id).sort()).toEqual(
      [founder.id, third.id, second.id].sort(),
    )
    const beforeRow = before.tabs.find((candidate) => candidate.id === founder.id)
    expect(beforeRow).toBeDefined()
    expect(beforeRow?.layout.kids).toEqual([founder.id, third.id])
    expect(beforeRow?.layout.ratio[0]).toBeCloseTo(0.6)
    expect(beforeRow?.layout.ratio[1]).toBeCloseTo(0.4)

    // Split A again. B is live, in this tab's tmux group, and in
    // `config.panes` — but the row just proved it has no seat in
    // `layout.kids`, which is exactly `splitPane`'s "unclaimed sibling" case.
    const split3 = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 40, rows: 20,
    })
    const fourth = split3.panes[1] // D, inserted after A: kids [A, D, C, B]
    await waitForPrompt(fourth.id)
    const row = split3.tabs[0]
    expect(row.layout.kids).toEqual([founder.id, fourth.id, third.id, second.id])
    const at = (id: string): number => row.layout.ratio[row.layout.kids.indexOf(id)]

    // Real, worth having — and, per the comment above, NOT what actually
    // proves B's dilution happened.
    expect(at(third.id) / (at(founder.id) + at(fourth.id))).toBeCloseTo(0.4 / 0.6)
    // The assertion that does: B ends up with some share of the axis.
    expect(at(second.id)).toBeGreaterThan(0)
    // Necessary, not sufficient on its own — see the comment above.
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  /**
   * The ratio survives the death and the restart, and used to flatten on the
   * next ⌘D.
   *
   * The renderer already keeps a dead pane's slot and share on screen
   * (`withKeptPanes`), so nothing on screen moved. Main's side did not:
   * `forgetTab` drops the pane's row at its death, so the next rebuild of that
   * tab's row met a kid the saved row had never heard of and handed it an even
   * share. `register.ts`'s `tombstones` is what main remembers across those
   * two events.
   *
   * All THREE shares are asserted, not just the restarted pane's. Before the
   * fix every share here is 1/3 — `shareOf` falls through to
   * `1 / siblings.length`, giving `[0.5, 0.5, 0.5]`, which normalises to
   * thirds — so an assertion on the restarted pane alone would have to
   * distinguish 0.3 from 0.3333, while the founder's distinguishes 0.35 from
   * 0.3333 as well. A window admitting both the defect and the fix is worse
   * than no test, and 0.3333 sits inside any window loose enough to hold both.
   *
   * The numbers, derived rather than guessed. The row on disk after the
   * restart is `kids [founder]`, `ratio [1]` — asserted below, because it is
   * what makes the rest arithmetic rather than assertion: `restartTab` reads
   * config while the dead pane's row is still gone, so `normaliseLayout` drops
   * the dangling kid and rescales the founder's 0.7 to 1.0. The split then
   * halves that 1.0 between the founder and the new pane, and the remembered
   * 0.3 is a claim on the WHOLE tab, so those two halves scale into the 0.7
   * that is left: 0.35, 0.35, 0.3.
   */
  it('gives a restarted pane the share it had when it died, not an even one', async () => {
    const { founder, second } = await splitThenRestartSibling({ founder: 0.7, second: 0.3 })

    // The precondition the numbers below are derived from, asserted rather
    // than assumed — `splitThenRestartSibling` pins the kids, this pins the
    // share they were rescaled to.
    const before = await written()
    const beforeRow = before.tabs.find((candidate) => candidate.id === founder.id)
    expect(beforeRow).toBeDefined()
    expect(beforeRow?.layout.ratio).toEqual([1])

    // A split is the cheapest thing that makes main rewrite the tab's row,
    // which is where the share was being lost — the renderer's own copy was
    // right all along.
    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 40, rows: 20,
    })
    expect(shape.panes).toHaveLength(3)
    const third = shape.panes[1]
    await waitForPrompt(third.id)

    const row = shape.tabs[0]
    expect(row.layout.kids).toEqual([founder.id, third.id, second.id])
    const at = (id: string): number => row.layout.ratio[row.layout.kids.indexOf(id)]
    expect(at(second.id)).toBeCloseTo(0.3)
    expect(at(founder.id)).toBeCloseTo(0.35)
    expect(at(third.id)).toBeCloseTo(0.35)
    // By construction, not by a rescale bolted on afterwards.
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)

    // And the file says the same thing the reply did. Read raw: `store.read()`
    // rescales every ratio by its own total on the way in, so a row written
    // summing to 1.3 would read back looking perfect.
    const after = await written()
    const afterRow = after.tabs.find((candidate) => candidate.id === founder.id)
    expect(afterRow).toBeDefined()
    expect(afterRow?.layout).toEqual(row.layout)
  })

  /**
   * The same ruling on the OTHER rebuild of a tab's row.
   *
   * `splitPane` goes through `carveRatio` and `closePane` through
   * `tabRowFor`, and both now read the same `tombstones` through the same
   * `sharesAroundClaims`. One authority, so the two cannot drift — but a
   * passing suite is what makes that true tomorrow, and with only the split
   * test above, dropping the map from `closePane`'s call would leave every
   * assertion in this file green.
   *
   * Needs three panes and its own death: a close only meets the remembered
   * pane while the row still does not claim it, and a split repairs the row on
   * its way past, so the split test above cannot be extended into this one.
   *
   * The numbers. A:C:B at 0.5:0.3:0.2, then B dies — remembered at 0.2 — and
   * comes back, leaving the row claiming A and C alone, rescaled to 0.625 and
   * 0.375. Closing C leaves A as the only kid the row still knows, so A's
   * 0.625 is the whole of the base and scales into the 0.8 that B's claim
   * leaves: A 0.8, B 0.2. Without the remembered share B takes an even 0.5
   * against A's 0.625 and the pair normalise to 0.556 and 0.444 — which sums
   * to 1 and looks perfectly healthy, so the sum assertion cannot see it and
   * both shares are pinned instead.
   */
  it('gives a restarted pane the share it died at when a sibling is closed', async () => {
    const { founder, second } = await splitOnce() // A, B — kids [A, B]
    const split2 = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 100, rows: 30,
    })
    expect(split2.panes).toHaveLength(3)
    const third = split2.panes[1] // C, inserted after A: kids [A, C, B]
    await waitForPrompt(third.id)
    expect(split2.tabs[0].layout.kids).toEqual([founder.id, third.id, second.id])

    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.5, [third.id]: 0.3, [second.id]: 0.2 } as never,
    )
    await settle(200)

    // B dies for real and comes back — the death hook's own two commands, in
    // its order, the way every other death in this file is staged.
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const secondWindow = await adapter.windowIdOf(second.tmuxSession)
    expect(secondWindow).toMatch(/^@\d+$/)
    const exitEvent = waitForExitEvent(second.id)
    await run('tmux', [
      '-L', SOCKET,
      'kill-session', '-t', `=${second.tmuxSession}`, ';', 'kill-window', '-t', secondWindow,
    ])
    await exitEvent
    await expect(adapter.hasSession(second.tmuxSession)).resolves.toBe(false)
    const restarted = await invoke<TabDescriptor>(CHANNELS.restartTab, {
      tab: second, cols: 100, rows: 30,
    })
    await expect.poll(() => adapter.hasSession(restarted.tmuxSession), { timeout: 8000 }).toBe(true)

    // The precondition, asserted rather than assumed: A and C alone in the
    // row at 0.625/0.375, with B live and claimed by nothing.
    const before = await written()
    const beforeRow = before.tabs.find((candidate) => candidate.id === founder.id)
    expect(beforeRow).toBeDefined()
    expect(beforeRow?.layout.kids).toEqual([founder.id, third.id])
    expect(beforeRow?.layout.ratio[0]).toBeCloseTo(0.625)
    expect(beforeRow?.layout.ratio[1]).toBeCloseTo(0.375)

    const closed = await invoke<TabShape>(CHANNELS.closePane, third.id)
    const row = closed.tabs[0]
    expect(row.layout.kids).toEqual([founder.id, second.id])
    const at = (id: string): number => row.layout.ratio[row.layout.kids.indexOf(id)]
    expect(at(second.id)).toBeCloseTo(0.2)
    expect(at(founder.id)).toBeCloseTo(0.8)
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  /**
   * The second death in one tab, which is where a share recorded straight off
   * the row is no longer a share of the tab.
   *
   * `forgetTab` reads through `store.read()`, and that reader has ALREADY
   * rescaled the row over the survivors of every earlier death — the same
   * rescale the two tests above depend on to turn `[0.7, 0.3]` into `[1]`. So
   * the first death records a true whole-tab share and every later one records
   * a share of what the earlier deaths left, which is bigger. Here C really
   * dies at 0.3 of the tab and the row says 0.375, because B's 0.2 has already
   * been redistributed into it.
   *
   * Recording the 0.375 is silent and it is wrong in the direction that hurts:
   * C comes back a quarter wider than it died, out of panes the user never
   * touched, and `withKeptPanes` has been holding C on screen at 0.3 the whole
   * time — the renderer's reinsertion scales nothing — so the pane visibly
   * jumps the moment main's row names it. That is the symptom this whole task
   * exists to kill, arriving one death later.
   *
   * `× (1 - the claims already held for that tab)` converts it back, and the
   * reasoning is in `forgetTab`: once B is gone the row describes the tab as
   * if B does not exist, so its shares are fractions of `1 - claimB`.
   * Measured: 0.375 × 0.8 = 0.3, exactly what C died at.
   *
   * B is never restarted, deliberately — its claim only has to exist for the
   * correction to need it, and one fewer session is one fewer pty in the
   * file that spends the most of them.
   */
  it('records a share of the whole tab when a second pane dies in it', async () => {
    const { founder, second } = await splitOnce() // A, B — kids [A, B]
    const split2 = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 100, rows: 30,
    })
    expect(split2.panes).toHaveLength(3)
    const third = split2.panes[1] // C, inserted after A: kids [A, C, B]
    await waitForPrompt(third.id)
    expect(split2.tabs[0].layout.kids).toEqual([founder.id, third.id, second.id])

    // A 0.5, C 0.3, B 0.2 — chosen so that C's true share and the share the
    // row will claim for it after B's death (0.375) are far apart.
    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.5, [third.id]: 0.3, [second.id]: 0.2 } as never,
    )
    await settle(200)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    /** A real death, staged the way the death hook stages one. */
    const kill = async (pane: TabDescriptor): Promise<void> => {
      const window = await adapter.windowIdOf(pane.tmuxSession)
      expect(window).toMatch(/^@\d+$/)
      const exited = waitForExitEvent(pane.id)
      await run('tmux', [
        '-L', SOCKET,
        'kill-session', '-t', `=${pane.tmuxSession}`, ';', 'kill-window', '-t', window,
      ])
      await exited
      await expect(adapter.hasSession(pane.tmuxSession)).resolves.toBe(false)
    }

    await kill(second) // B, at a true 0.2
    await expect
      .poll(async () => (await written()).panes.length, { timeout: 8000 })
      .toBe(2)

    // Asserted between the two deaths, because this is the state that makes
    // the second capture wrong — and it is the one assertion in this file that
    // deliberately reads through `store.read()` rather than `written()`. The
    // raw file still names B as a kid: `forgetTab` writes back the config it
    // read, and B's pane row was still there when it read. The rescale that
    // inflates C happens in the READER, on the way into the next pass — which
    // is `forgetTab`'s own next call. So `store.read()` is not a repair being
    // hidden here, it is exactly what the code under test is about to see.
    const between = await store.read()
    const betweenRow = between.tabs.find((candidate) => candidate.id === founder.id)
    expect(betweenRow).toBeDefined()
    expect(betweenRow?.layout.kids).toEqual([founder.id, third.id])
    expect(betweenRow?.layout.ratio[1]).toBeCloseTo(0.375)

    await kill(third) // C, at a true 0.3 that the row calls 0.375
    const restarted = await invoke<TabDescriptor>(CHANNELS.restartTab, {
      tab: third, cols: 100, rows: 30,
    })
    await expect.poll(() => adapter.hasSession(restarted.tmuxSession), { timeout: 8000 }).toBe(true)

    const before = await written()
    const beforeRow = before.tabs.find((candidate) => candidate.id === founder.id)
    expect(beforeRow).toBeDefined()
    expect(beforeRow?.layout.kids).toEqual([founder.id])

    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 40, rows: 20,
    })
    expect(shape.panes).toHaveLength(3)
    const fourth = shape.panes[1]
    await waitForPrompt(fourth.id)

    const row = shape.tabs[0]
    expect(row.layout.kids).toEqual([founder.id, fourth.id, third.id])
    const at = (id: string): number => row.layout.ratio[row.layout.kids.indexOf(id)]
    // The share C really died at. Recorded straight off the row it is 0.375,
    // and the founder and the new pane pay for the difference — 0.3125 each
    // instead of 0.35 — so all three assertions bite, in both directions.
    expect(at(third.id)).toBeCloseTo(0.3)
    expect(at(founder.id)).toBeCloseTo(0.35)
    expect(at(fourth.id)).toBeCloseTo(0.35)
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // The addendum's own test: the ONE place the `owed` write — `CHANNELS.setLayout`'s
  // `tombstones.set(entry.id, { tabId, share: entry.share })` — has ever been
  // exercised through a real death and a real restart, rather than through
  // `layoutWrite` with a `Map` built by hand (see `shares.test.ts`).
  it('keeps what a tombstone is owed current, so the next split reserves the dragged share', async () => {
    // A, C, B at 0.5/0.3/0.2. C dies and stays dead — a tombstone. B dies and
    // is restarted, so main owes it a claim and the row does not name it. The
    // user then drags C wider, and the next split must reserve the DRAGGED
    // share rather than the one C died at.
    const { founder, second } = await splitOnce()
    const split2 = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 100, rows: 30,
    })
    const third = split2.panes[1]
    await waitForPrompt(third.id)
    expect(split2.tabs[0].layout.kids).toEqual([founder.id, third.id, second.id])
    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.5, [third.id]: 0.3, [second.id]: 0.2 } as never,
    )
    await settle(200)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    // The same two-command death every other test in this file stages.
    const kill = async (pane: TabDescriptor): Promise<void> => {
      const window = await adapter.windowIdOf(pane.tmuxSession)
      expect(window).toMatch(/^@\d+$/)
      const exited = waitForExitEvent(pane.id)
      await run('tmux', [
        '-L', SOCKET,
        'kill-session', '-t', `=${pane.tmuxSession}`, ';', 'kill-window', '-t', window,
      ])
      await exited
      await expect(adapter.hasSession(pane.tmuxSession)).resolves.toBe(false)
    }

    // C dies and stays dead — the tombstone the drag below has to widen.
    await kill(third)
    await expect
      .poll(async () => (await written()).panes.length, { timeout: 8000 })
      .toBe(2)

    // B dies and is restarted: live, back in `config.panes`, owed a claim, and
    // — being restarted rather than rebuilt by a split or a close — still
    // unnamed by the row.
    await kill(second)
    const restarted = await invoke<TabDescriptor>(CHANNELS.restartTab, {
      tab: second, cols: 100, rows: 30,
    })
    await expect.poll(() => adapter.hasSession(restarted.tmuxSession), { timeout: 8000 }).toBe(true)

    // The precondition, asserted rather than assumed: both deaths have left
    // the row naming only the founder.
    const before = await written()
    const beforeRow = before.tabs.find((candidate) => candidate.id === founder.id)
    expect(beforeRow).toBeDefined()
    expect(beforeRow?.layout.kids).toEqual([founder.id])

    // The user then drags C — still dead, still off the row — wider.
    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.4, [third.id]: 0.4, [second.id]: 0.2 } as never,
    )
    await settle(200)

    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 100, rows: 30,
    })
    await waitForPrompt(shape.panes[shape.panes.length - 1].id)
    const row = shape.tabs[0]
    const at = (id: string): number => row.layout.ratio[row.layout.kids.indexOf(id)]
    // Whole tab: founder 0.2, new 0.2, second 0.2, third(tombstone) 0.4. The
    // three live kids hold 0.6, so each takes a third of the row. Without the
    // drag reaching the record, `third` would still be owed the 0.3 it died at,
    // the live kids would hold 0.7, and `second` would come back at 2/7 = 0.286.
    expect(at(second.id)).toBeCloseTo(1 / 3)
    expect(at(founder.id)).toBeCloseTo(1 / 3)
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })
})

describe('project channels', () => {
  it('adds a project and returns the new list', async () => {
    const projects = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    expect(projects.map((p) => p.name)).toEqual(['Lumio'])
    await expect(store.read().then((c) => c.projects.map((p) => p.slug))).resolves.toEqual(['lumio'])
  })

  it('refuses the same folder twice', async () => {
    await invoke(CHANNELS.addProject, { name: 'Lumio', cwd: tmpdir() })
    await expect(invoke(CHANNELS.addProject, { name: 'Other', cwd: tmpdir() })).rejects.toThrow(
      /already/i,
    )
  })

  it('renames without moving the slug', async () => {
    const [added] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const after = await invoke<ProjectDescriptor[]>(CHANNELS.updateProject, added.id, {
      name: 'Lumio Ltd',
    })
    expect(after[0].name).toBe('Lumio Ltd')
    expect(after[0].slug).toBe('lumio')
  })

  it('reorders projects', async () => {
    const [first] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const second = (
      await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
        name: 'Studio',
        cwd: join(tmpdir(), 'studio'),
      })
    )[1]
    const after = await invoke<ProjectDescriptor[]>(CHANNELS.reorderProjects, [
      second.id,
      first.id,
    ])
    expect(after.map((p) => p.slug)).toEqual(['studio', 'lumio'])
    await expect(store.read().then((c) => c.projects.map((p) => p.slug))).resolves.toEqual([
      'studio',
      'lumio',
    ])
  })

  // The milestone's promise: removing a project does not touch its sessions.
  // The reply has to say where they went, or they drop off the screen until the
  // next launch — which is why every mutation appends Unsorted.
  it('keeps a removed project’s sessions reachable under Unsorted', async () => {
    const [project] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const tab = await openTabIn('lumio')
    await waitForPrompt(tab.id)

    const after = await invoke<ProjectDescriptor[]>(CHANNELS.removeProject, project.id)

    expect(after.map((p) => p.id)).toEqual([UNSORTED_ID])
    expect(after[0].activeTabId).toBe(tab.id)
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(true)
  })

  // A detached tab is still in the tab bar: only its client is gone, and its
  // session is still running. So the tab set a mutation describes against is
  // the config's, not the manager's — the latter would drop the Unsorted row
  // this stray needs and leave it nowhere to be drawn.
  it('lists Unsorted for a stray whose client has detached', async () => {
    const tab = await openTabIn('stray')
    await waitForPrompt(tab.id)
    detachTab(tab.id)
    await settle(500)

    const projects = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    expect(projects.map((p) => p.slug)).toEqual(['lumio', UNSORTED_ID])
  })

  it('records the active tab against the project that owns it', async () => {
    await invoke(CHANNELS.addProject, { name: 'Lumio', cwd: tmpdir() })
    const tab = await openTabIn('lumio')
    ipc.listeners.get(CHANNELS.setActive)?.(null as never, tab.id as never)
    await settle(200)
    await expect(store.read().then((c) => c.projects[0].activeTabId)).resolves.toBe(tab.id)
  })

  // A tab under Unsorted has no project row to record it against, and its
  // active tab is deliberately not persisted.
  it('ignores setActive for a tab belonging to no project', async () => {
    const tab = await openTab()
    ipc.listeners.get(CHANNELS.setActive)?.(null as never, tab.id as never)
    await settle(200)
    await expect(store.read().then((c) => c.projects)).resolves.toEqual([])
  })

  it('remembers which project is selected', async () => {
    const [project] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    ipc.listeners.get(CHANNELS.setActiveProject)?.(null as never, project.id as never)
    await settle(200)
    await expect(store.read().then((c) => c.activeProjectId)).resolves.toBe(project.id)
  })

  // The tab starts under a slug no project holds: having nowhere to live is
  // what makes it worth moving.
  it('moves a tab into a project by renaming its tmux session', async () => {
    const [project] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const tab = await openTabIn('stray')
    // The session only exists once tmux has actually created it.
    await waitForPrompt(tab.id)
    const before = tab.tmuxSession

    const moved = await invoke<{ projects: ProjectDescriptor[]; panes: TabDescriptor[] }>(
      CHANNELS.moveTabToProject,
      tab.id,
      project.id,
    )

    // One pane, because this tab was never split — asserted before anything
    // reads out of the list.
    expect(moved.panes).toHaveLength(1)
    expect(moved.panes[0].projectSlug).toBe('lumio')
    expect(moved.panes[0].id).toBe(tab.id)
    expect(moved.panes[0].tmuxSession).toBe(`prcli-lumio-${tab.id}`)
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await expect(adapter.hasSession(moved.panes[0].tmuxSession)).resolves.toBe(true)
    await expect(adapter.hasSession(before)).resolves.toBe(false)
    // Nothing is stray any more, so there is nothing for Unsorted to hold.
    expect(moved.projects.map((p) => p.id)).toEqual([project.id])
    await expect(store.read().then((c) => c.panes.map((p) => p.tmuxSession))).resolves.toEqual([
      moved.panes[0].tmuxSession,
    ])
  })

  // A pane's project lives in its own member session name and, on disk, in its
  // own row — so a move that writes back one row leaves the tab split across
  // two projects the moment a second pane exists. No IPC splits a tab yet
  // (plan 2b), so the second pane is made through the manager and its row
  // written the way that command's handler will write it.
  //
  // Both panes are detached first: that is what makes the per-pane `known` map
  // load-bearing. A detached pane is resolved through tmux, whose
  // `pane_current_path` answers with the symlink-resolved `/private/var/...`
  // rather than the `/var/...` config holds, so a row whose cwd survives
  // verbatim can only have come from config.
  it('moves every pane of a split tab, and saves a row for each', async () => {
    const [project] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const founder = await openTabIn('stray')
    await waitForPrompt(founder.id)
    // Its own directory, so a write-back that put one pane's record into both
    // rows shows up as well as one that left a row behind.
    const secondCwd = join(configDir, 'second-pane')
    await mkdir(secondCwd, { recursive: true })
    const second = await manager.splitTab({ paneId: founder.id, cwd: secondCwd })
    await waitForPrompt(second.id)
    const seeded = await store.read()
    await store.write({ ...seeded, panes: [...seeded.panes, second] })
    detachTab(founder.id)
    detachTab(second.id)
    await settle(500)

    await invoke<{ projects: ProjectDescriptor[]; panes: TabDescriptor[] }>(
      CHANNELS.moveTabToProject,
      founder.id,
      project.id,
    )

    // Live tmux, not the reply: every member session carries the destination
    // slug in its own name.
    const live = await manager.panesOfTab(founder.id)
    expect(live).toHaveLength(2)
    for (const pane of live) expect(pane.projectSlug).toBe('lumio')

    // And config says the same for both, which is what a relaunch reads.
    const saved = (await store.read()).panes
    expect(saved).toHaveLength(2)
    for (const row of saved) {
      expect(row.projectSlug).toBe('lumio')
      expect(row.tmuxSession).toBe(`prcli-lumio-${row.id}`)
    }
    expect(saved.map((row) => row.id).sort()).toEqual([founder.id, second.id].sort())
    expect(saved.find((row) => row.id === second.id)?.cwd).toBe(secondCwd)
  })

  // The same session name, so there is nothing to rename and nothing to
  // reattach — the tab keeps its client rather than being torn down for a move
  // that is already made.
  it('leaves a tab alone when it is already in the target project', async () => {
    const [project] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const tab = await openTabIn('lumio')
    await waitForPrompt(tab.id)

    const moved = await invoke<{ projects: ProjectDescriptor[]; panes: TabDescriptor[] }>(
      CHANNELS.moveTabToProject,
      tab.id,
      project.id,
    )

    expect(moved.panes).toHaveLength(1)
    expect(moved.panes[0].tmuxSession).toBe(tab.tmuxSession)
    expect(manager.get(tab.id)?.tmuxSession).toBe(tab.tmuxSession)
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(true)
  })

  // A detached tab is still movable: its session is running, it just has no
  // client here. The move finds its panes through `panesOfTab`, which for a
  // pane with no open entry has to ask tmux for a cwd — so the directory
  // config already holds has to survive, which is what `known` is for.
  it('moves a detached tab without losing its working directory', async () => {
    const [project] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const tab = await openTabIn('stray')
    await waitForPrompt(tab.id)
    const before = (await store.read()).panes.find((row) => row.id === tab.id)?.cwd
    expect(before).toBe(tmpdir())
    detachTab(tab.id)
    await settle(500)

    const moved = await invoke<{ panes: TabDescriptor[] }>(
      CHANNELS.moveTabToProject,
      tab.id,
      project.id,
    )

    expect(moved.panes).toHaveLength(1)
    expect(moved.panes[0].tmuxSession).toBe(`prcli-lumio-${tab.id}`)
    expect(moved.panes[0].cwd).toBe(before)
    await expect(store.read().then((c) => c.panes.map((p) => p.cwd))).resolves.toEqual([before])
  })

  // A pane's launch intent is not recoverable from tmux — `panesOfTab`
  // synthesises `shell` for a pane with no open entry, because a session name
  // does not say what it was started for. So a DETACHED claude pane moved
  // between projects was written back to disk as a shell, and the next restore
  // opened it as one: no dot of its own, and nothing left on disk saying what
  // it was. The cwd assertion above covers the same hole for a different
  // field; this is the one the branch's `known` map did not carry.
  it('moves a detached claude tab without downgrading it to a shell', async () => {
    const [project] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const tab = await invoke<TabDescriptor>(CHANNELS.open, {
      projectSlug: 'stray',
      cwd: tmpdir(),
      type: 'claude',
    })
    await waitForPrompt(tab.id)
    expect((await store.read()).panes.find((row) => row.id === tab.id)?.type).toBe('claude')
    detachTab(tab.id)
    await settle(500)

    const moved = await invoke<{ panes: TabDescriptor[] }>(
      CHANNELS.moveTabToProject,
      tab.id,
      project.id,
    )

    expect(moved.panes).toHaveLength(1)
    expect(moved.panes[0].type).toBe('claude')
    const saved = (await store.read()).panes
    expect(saved).toHaveLength(1)
    expect(saved[0].type).toBe('claude')
  })

  it('refuses to move a tab into a project that does not exist', async () => {
    const tab = await openTab()
    await expect(invoke(CHANNELS.moveTabToProject, tab.id, 'nope')).rejects.toThrow(/no project/i)
  })

  // The scan must never see the developer's real ~/Code.
  it('offers candidates from the projects root, minus the ones already added', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prcli-root-'))
    const previous = process.env.PRCLI_PROJECTS_ROOT
    process.env.PRCLI_PROJECTS_ROOT = root
    try {
      for (const name of ['lumio', 'studio']) {
        await mkdir(join(root, name), { recursive: true })
        await writeFile(join(root, name, 'package.json'), '{}', 'utf8')
      }
      await invoke(CHANNELS.addProject, { name: 'Studio', cwd: join(root, 'studio') })

      const candidates = await invoke<Candidate[]>(CHANNELS.scanCandidates)
      expect(candidates.map((c) => c.name)).toEqual(['lumio'])
      expect(candidates[0].markers).toEqual(['package.json'])
    } finally {
      if (previous === undefined) delete process.env.PRCLI_PROJECTS_ROOT
      else process.env.PRCLI_PROJECTS_ROOT = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers the folder picker with the chosen path, and null when cancelled', async () => {
    await expect(invoke(CHANNELS.pickFolder)).resolves.toBeNull()
    ipc.folderChoice = { canceled: false, filePaths: [tmpdir()] }
    await expect(invoke(CHANNELS.pickFolder)).resolves.toBe(tmpdir())
  })

  it('refuses to open a terminal in a directory that is not there', async () => {
    await expect(
      invoke(CHANNELS.open, {
        projectSlug: 'lumio',
        cwd: join(tmpdir(), 'definitely-not-here-9f3a'),
      }),
    ).rejects.toThrow(/not a directory/i)
  })
})

describe('status registry', () => {
  function status(): Promise<Record<string, TabState>> {
    return invoke<Record<string, TabState>>(CHANNELS.status)
  }

  // The brief wires `registry.applyExit` into the exit handler on any
  // `!sessionAlive`, with no exception for `killed`. That races the
  // CHANNELS.closePane handler's own `registry.forget` — both are `.then`
  // reactions on the exact same `manager.kill()` promise, with no ordering
  // guarantee between them. A kill the user asked for must never leave a
  // tombstone: nothing else will ever call `forget` for this id again, since
  // the row is already gone from config and the tab from the tab bar.
  it('never leaves a tombstone behind for a tab killed on purpose', async () => {
    const tab = await invoke<TabDescriptor>(CHANNELS.open, {
      projectSlug: 'lumio',
      cwd: tmpdir(),
      type: 'preset',
      command: 'true',
    })
    expect((await status())[tab.id]).toBe('running')

    await killTab(tab.id)
    await settle(300)

    expect((await status())[tab.id]).toBeUndefined()
  })

  // I4: the exit handler used to forget the tab's saved config row before
  // stamping the registry, so by the time anything tried to resolve the tab
  // from its id alone — which is exactly what the notification router does —
  // both the live manager entry and the saved row could already be gone, and
  // `crashed`/`ended` could never reach a toast. `applyExit` now receives the
  // dying tab's own record directly from the exit handler, sidestepping that
  // lookup outright rather than betting on read/write ordering.
  // Asserted on the transition the registry emits, not on the arguments
  // `applyExit` was called with: a spy on a positional argument restates the
  // implementation and would keep passing if the record arrived and went
  // nowhere. What a listener actually receives is the contract — it is all
  // the notification router ever sees.
  it('carries the dying tab on its transition, though the saved row is already gone', async () => {
    const tab = await invoke<TabDescriptor>(CHANNELS.open, { projectSlug: 'lumio', cwd: tmpdir() })
    await waitForPrompt(tab.id)
    const seen: { to: TabState | null; tab?: TabDescriptor }[] = []
    registry.onTransition((transition) => {
      if (transition.tabId === tab.id) seen.push({ to: transition.to, tab: transition.tab })
    })

    // Exactly what a crash outside the app leaves behind, with nothing
    // routed through manager.kill() or CHANNELS.closePane — the `exited` path,
    // where the config row is forgotten in this very same handler.
    const exitEvent = waitForExitEvent(tab.id)
    await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${tab.tmuxSession}`])
    await exitEvent
    await settle(200)

    expect(seen).toHaveLength(1)
    expect(seen[0].to).toBe('ended')
    expect(seen[0].tab).toMatchObject({ id: tab.id, tmuxSession: tab.tmuxSession })

    // The half that makes carrying the record necessary rather than tidy: by
    // now there is nothing left to look the tab up in. A listener handed only
    // an id would find nothing and drop the notification.
    await expect(store.read().then((config) => config.panes.map((row) => row.id))).resolves.not
      .toContain(tab.id)
  })

  // restoreWorkspace reattaches every tab through `manager.open` directly,
  // never through the CHANNELS.open handler — so on the brief's version
  // nothing ever gives a relaunch-restored tab an initial state. A restored
  // `claude` tab would draw no dot at all, indistinguishable from a shell
  // nobody has typed into, rather than the hollow `unknown` a tab that should
  // have a state and does not deserves.
  it('gives a relaunch-restored claude tab a state, not silence', async () => {
    const tab = await invoke<TabDescriptor>(CHANNELS.open, {
      projectSlug: 'lumio',
      cwd: tmpdir(),
      type: 'claude',
    })
    await waitForPrompt(tab.id)
    detachTab(tab.id)
    await settle(500)

    // A fresh process: a new manager and a new, empty registry, with the
    // tmux session still alive underneath — exactly what a relaunch is.
    useManager()
    const restored = await restoreTabs()
    // `restored.panes`, same reason as above: `restored.tabs` is `TabRow[]`
    // now, and this test wants the pane that came back, not its tab row.
    expect(restored.panes.map((entry) => entry.id)).toEqual([tab.id])

    expect((await status())[tab.id]).toBe('unknown')
  })

  // Restore is also how the renderer re-fetches the workspace on its own
  // reload (⌘R), and by then the registry already knows real states from
  // hook events main never stopped receiving. Populating every restored
  // tab unconditionally — the naive reading of "give restored tabs a state"
  // — would stamp a tab already `waiting` back to `unknown` on every ⌘R,
  // which is precisely the "a ⌘R must not blank the board" defect this task
  // exists to avoid.
  it('does not blank a tab restore already knows the real state of', async () => {
    const tab = await invoke<TabDescriptor>(CHANNELS.open, {
      projectSlug: 'lumio',
      cwd: tmpdir(),
      type: 'claude',
    })
    await waitForPrompt(tab.id)

    // Stands in for a hook event landing on the registry — wiring the real
    // hook socket into main is a later task, but the registry's own surface
    // is exactly what a `Notification` hook drives.
    registry.applyHook({ tabId: tab.id, event: 'Notification', at: Date.now() })
    expect((await status())[tab.id]).toBe('waiting')

    await restoreTabs()

    expect((await status())[tab.id]).toBe('waiting')
  })
})

describe('notification channels', () => {
  it('reads the defaults with nothing written yet', async () => {
    const config = await invoke<NotificationConfig>(CHANNELS.notifications)
    expect(config.rules.some((rule) => rule.on === 'waiting')).toBe(true)
  })

  it('merges a patch and persists it to disk', async () => {
    const before = await invoke<NotificationConfig>(CHANNELS.notifications)
    const rules = [...before.rules, { project: 'p1', toast: false }]

    const after = await invoke<NotificationConfig>(CHANNELS.updateNotifications, { rules })

    expect(after.rules).toEqual(rules)
    expect((await store.read()).notifications.rules).toEqual(rules)
  })

  // updateNotifications merges the patch onto the existing config, so a caller
  // that only sends `rules` — the sidebar's mute toggle — must not blank out
  // fields it never mentioned.
  it('does not disturb fields the patch does not mention', async () => {
    const before = await invoke<NotificationConfig>(CHANNELS.notifications)

    const after = await invoke<NotificationConfig>(CHANNELS.updateNotifications, { rules: [] })

    expect(after.muteWhenFocused).toBe(before.muteWhenFocused)
    expect(after.quietHours).toEqual(before.quietHours)
  })
})

describe('hooks channels', () => {
  // These reach ~/.claude/settings.json for real once outside a test — see
  // src/main/hooks/install.ts. Both escape hatches are set here, restored
  // after, exactly as install.test.ts does, so this suite can never touch the
  // developer's real file even though it drives the channels through
  // registerIpc rather than the functions directly.
  let hooksDir: string
  let hooksSettings: string
  const savedEnv = { config: process.env.PRCLI_CONFIG_DIR, claude: process.env.PRCLI_CLAUDE_SETTINGS }

  beforeEach(async () => {
    hooksDir = await mkdtemp(join(tmpdir(), 'prcli-hooks-ipc-'))
    hooksSettings = join(hooksDir, 'settings.json')
    process.env.PRCLI_CONFIG_DIR = hooksDir
    process.env.PRCLI_CLAUDE_SETTINGS = hooksSettings
  })

  afterEach(async () => {
    process.env.PRCLI_CONFIG_DIR = savedEnv.config
    process.env.PRCLI_CLAUDE_SETTINGS = savedEnv.claude
    await rm(hooksDir, { recursive: true, force: true })
  })

  it('wires hooksState/installHooks/uninstallHooks through to install.ts', async () => {
    const before = await invoke<HooksState>(CHANNELS.hooksState)
    expect(before.installed).toBe(false)
    expect(before.settingsPath).toBe(hooksSettings)

    const installed = await invoke<HooksState>(CHANNELS.installHooks)
    expect(installed.installed).toBe(true)

    const uninstalled = await invoke<HooksState>(CHANNELS.uninstallHooks)
    expect(uninstalled.installed).toBe(false)
  })

  // installHooks/uninstallHooks write a different file than the config write
  // queue owns, and must never be routed through it: that queue has no
  // reentrancy protection, so anything sharing it with a stuck operation
  // would hang right along with it. Gating store.read() mid-flight and
  // holding a queued addProject there proves installHooks resolves anyway.
  it('does not queue behind a pending config write', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalRead = store.read.bind(store)
    const readSpy = vi.spyOn(store, 'read').mockImplementationOnce(async () => {
      await gate
      return originalRead()
    })

    const stuck = invoke<ProjectDescriptor[]>(CHANNELS.addProject, { name: 'Stuck', cwd: tmpdir() })

    const raced = await Promise.race([
      invoke<HooksState>(CHANNELS.installHooks).then((state) => ({ hung: false as const, state })),
      new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), 2000)),
    ])
    expect(raced.hung).toBe(false)
    if (!raced.hung) expect(raced.state.installed).toBe(true)

    release()
    await stuck
    readSpy.mockRestore()
  })
})
