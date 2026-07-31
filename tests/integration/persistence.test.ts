import { describe, it, expect, afterAll, afterEach, beforeEach, beforeAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Candidate,
  HooksState,
  NotificationConfig,
  ProjectDescriptor,
  RestoreResult,
  TabDescriptor,
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
  return (await store.read()).tabs.map((tab) => tab.id)
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

function killTab(id: string): Promise<void> {
  const handler = ipc.handlers.get(CHANNELS.kill)
  if (!handler) throw new Error('kill handler was not registered')
  return handler(null as never, id as never) as Promise<void>
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
function waitForExitEvent(
  id: string,
  ms = 8000,
): Promise<{ id: string; code: number; sessionAlive: boolean }> {
  const deadline = Date.now() + ms
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const found = sentEvents.find(
        (event) =>
          event.channel === CHANNELS.exit && (event.payload as { id: string }).id === id,
      )
      if (found) {
        resolve(found.payload as { id: string; code: number; sessionAlive: boolean })
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
    expect(restored.tabs.map((entry) => entry.id)).toEqual([tab.id])
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

    const moved = await invoke<{ projects: ProjectDescriptor[]; tab: TabDescriptor }>(
      CHANNELS.moveTabToProject,
      tab.id,
      project.id,
    )

    expect(moved.tab.projectSlug).toBe('lumio')
    expect(moved.tab.id).toBe(tab.id)
    expect(moved.tab.tmuxSession).toBe(`prcli-lumio-${tab.id}`)
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await expect(adapter.hasSession(moved.tab.tmuxSession)).resolves.toBe(true)
    await expect(adapter.hasSession(before)).resolves.toBe(false)
    // Nothing is stray any more, so there is nothing for Unsorted to hold.
    expect(moved.projects.map((p) => p.id)).toEqual([project.id])
    await expect(store.read().then((c) => c.tabs.map((t) => t.tmuxSession))).resolves.toEqual([
      moved.tab.tmuxSession,
    ])
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

    const moved = await invoke<{ projects: ProjectDescriptor[]; tab: TabDescriptor }>(
      CHANNELS.moveTabToProject,
      tab.id,
      project.id,
    )

    expect(moved.tab.tmuxSession).toBe(tab.tmuxSession)
    expect(manager.get(tab.id)?.tmuxSession).toBe(tab.tmuxSession)
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(true)
  })

  // A detached tab is still movable: its session is running, it just has no
  // client here. The move finds it through `findOrphans`, which has to
  // synthesise a cwd — so the directory config already holds has to survive.
  it('moves a detached tab without losing its working directory', async () => {
    const [project] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const tab = await openTabIn('stray')
    await waitForPrompt(tab.id)
    const before = (await store.read()).tabs.find((row) => row.id === tab.id)?.cwd
    expect(before).toBe(tmpdir())
    detachTab(tab.id)
    await settle(500)

    const moved = await invoke<{ tab: TabDescriptor }>(
      CHANNELS.moveTabToProject,
      tab.id,
      project.id,
    )

    expect(moved.tab.tmuxSession).toBe(`prcli-lumio-${tab.id}`)
    expect(moved.tab.cwd).toBe(before)
    await expect(store.read().then((c) => c.tabs.map((t) => t.cwd))).resolves.toEqual([before])
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
  // CHANNELS.kill handler's own `registry.forget` — both are `.then`
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
  it("passes the dying tab's own record into applyExit, not just its id", async () => {
    const tab = await invoke<TabDescriptor>(CHANNELS.open, { projectSlug: 'lumio', cwd: tmpdir() })
    await waitForPrompt(tab.id)
    const applyExit = vi.spyOn(registry, 'applyExit')

    // Exactly what a crash outside the app leaves behind, with nothing
    // routed through manager.kill() or CHANNELS.kill — the `exited` path,
    // where the config row is forgotten in this very same handler.
    const exitEvent = waitForExitEvent(tab.id)
    await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${tab.tmuxSession}`])
    await exitEvent
    await settle(200)

    expect(applyExit).toHaveBeenCalledTimes(1)
    expect(applyExit.mock.calls[0]?.[2]).toMatchObject({
      id: tab.id,
      tmuxSession: tab.tmuxSession,
    })
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
    expect(restored.tabs.map((entry) => entry.id)).toEqual([tab.id])

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
