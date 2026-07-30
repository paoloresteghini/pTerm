import { describe, it, expect, afterAll, afterEach, beforeEach, beforeAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RestoreResult } from '../../src/shared/ipc'

// registerIpc reaches for electron's ipcMain, which does not exist outside the
// main process. Capturing the handlers lets the real persistence path run.
const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => ipc.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: never[]) => unknown) => ipc.listeners.set(channel, fn),
  },
}))

const { CHANNELS } = await import('../../src/shared/ipc')
const { TmuxAdapter } = await import('../../src/main/tmux/adapter')
const { SessionManager } = await import('../../src/main/sessions/manager')
const { ConfigStore } = await import('../../src/main/state/store')
const { registerIpc } = await import('../../src/main/ipc/register')

type Manager = InstanceType<typeof SessionManager>
type Store = InstanceType<typeof ConfigStore>

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

/** Rebuild the whole main-process wiring, optionally against a different tmux. */
function useManager(bin?: string): void {
  ipc.handlers.clear()
  ipc.listeners.clear()
  manager = new SessionManager(new TmuxAdapter({ socket: SOCKET, bin }))
  registerIpc(manager, () => null, store)
}

beforeAll(killServer)

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'prcli-persist-'))
  store = new ConfigStore(join(configDir, 'config.json'))
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
