import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectRecord } from '../../src/main/state/store'
import type { TerminalPaneRecord } from '../../src/main/sessions/manager'

// registerIpc reaches for electron's ipcMain, which does not exist outside the
// main process. Capturing the handlers here is the harness openBrowser.test.ts
// and persistence.test.ts already use; this file follows it rather than
// standing up a second one.
const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => ipc.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: never[]) => unknown) => ipc.listeners.set(channel, fn),
  },
  dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
}))

const { CHANNELS } = await import('../../src/shared/ipc')
const { TmuxAdapter } = await import('../../src/main/tmux/adapter')
const { SessionManager } = await import('../../src/main/sessions/manager')
const { ConfigStore } = await import('../../src/main/state/store')
const { registerIpc } = await import('../../src/main/ipc/register')
const { StatusRegistry } = await import('../../src/main/status/registry')

/**
 * The project every test here announces a server for. Its id and its slug are
 * deliberately different strings: the registry files by slug and this channel
 * is asked by slug, while `openBrowser` next to it takes an id, so a project
 * whose two names happened to match would let a wiring that swapped them pass
 * every assertion below.
 */
const PROJECT_ID = 'p-alpha'
const PROJECT_SLUG = 'demo-app'

/**
 * The `Local:` line of a Vite banner as a pty actually delivers it, copied
 * character for character out of `CAPTURED_VITE_CHUNK` in
 * `tests/unit/devServerScan.test.ts` (that header records how the capture was
 * taken; this is its first line, up to and including the `\r\n`).
 *
 * Copied rather than written to look like Vite, because the difference is the
 * whole reason the scanner has the shape it has and the two are not
 * interchangeable. Vite writes the bold-off inside the URL as `\x1b[22m`, a
 * plain CSI; tmux re-emits it as terminfo's `sgr0`, `\x1b(B\x1b[m`, and every
 * pTerm pane is a tmux client. A fixture holding Vite's own `\x1b[22m`, which
 * this constant used to be, is passed by a scanner that strips CSI alone,
 * which is the exact defect that made this feature detect no real dev server
 * at all. That fixture could not fail, so none of the tests below could
 * either.
 */
const VITE_LINE =
  '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b(B\x1b[m:   \x1b[36mhttp://localhost:\x1b[1m5401\x1b(B\x1b[m\x1b[36m/\r\n'

/** The URL `VITE_LINE` announces, as the capture recorded it. */
const ANNOUNCED_URL = 'http://localhost:5401/'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler(null as never, ...(args as never[])) as Promise<T>
}

function devServerUrl(projectSlug: string): Promise<string | null> {
  return invoke<string | null>(CHANNELS.devServerUrl, projectSlug)
}

// The exit handler answers on a later tick (it awaits whether the session
// outlived its client, then the config write), so a test that reads back
// immediately would read the state before it changed. The same wait
// openBrowser.test.ts uses after driving a fire-and-forget channel.
const settle = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let configDir: string
let pane: TerminalPaneRecord
let emitData: (id: string, data: string) => void
let emitExit: (record: TerminalPaneRecord, code: number, reason: 'exited' | 'killed' | 'detached') => void

function project(): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: 'Alpha',
    slug: PROJECT_SLUG,
    cwd: configDir,
    presets: [],
    activeTabId: null,
    activeBrowserTabId: null,
  }
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'pterm-devserver-'))
  const store = new ConfigStore(join(configDir, 'config.json'))
  const empty = await store.read()
  await store.write({ ...empty, projects: [project()] })

  ipc.handlers.clear()
  ipc.listeners.clear()
  const manager = new SessionManager(new TmuxAdapter({ socket: 'pterm-devserver-test' }))

  // A live terminal pane of that project, without a tmux server to run it in.
  // `manager.get` is how main learns which project a chunk belongs to, and
  // this stands in for the entry a real `open()` would have left there.
  pane = {
    id: 'pane-1',
    projectSlug: PROJECT_SLUG,
    cwd: configDir,
    type: 'shell',
    tmuxSession: `pterm-${PROJECT_SLUG}-pane-1`,
  }
  vi.spyOn(manager, 'get').mockImplementation((id) => (id === pane.id ? pane : undefined))
  // Asked by the exit path to decide whether the session outlived its client.
  // Answering false is what makes an emitted exit below a real death.
  vi.spyOn(manager, 'hasSession').mockResolvedValue(false)

  // Spies that call through: what they are for is the callback itself, which
  // is the one main installs and the only way to feed this process a chunk
  // without a pty.
  const onData = vi.spyOn(manager, 'onData')
  const onExit = vi.spyOn(manager, 'onExit')

  const fakeWindow = { isDestroyed: () => false, webContents: { send: () => undefined } }
  registerIpc(manager, () => fakeWindow as never, new StatusRegistry(), store)

  emitData = onData.mock.calls[0][0]
  emitExit = onExit.mock.calls[0][0]
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(configDir, { recursive: true, force: true })
})

describe('CHANNELS.devServerUrl', () => {
  it('answers with the URL a pane of that project announced', async () => {
    emitData(pane.id, VITE_LINE)

    expect(await devServerUrl(PROJECT_SLUG)).toBe(ANNOUNCED_URL)
  })

  it('answers null before anything has announced a server', async () => {
    expect(await devServerUrl(PROJECT_SLUG)).toBeNull()
  })

  // The mismatch this feature is most likely to ship: panes carry a slug and
  // `openBrowser` takes an id, so a wiring that filed or looked up by the
  // wrong one of the two would answer here and be silent above.
  it('answers null for the project id, because this channel is keyed by slug', async () => {
    emitData(pane.id, VITE_LINE)

    expect(await devServerUrl(PROJECT_ID)).toBeNull()
  })

  it('forgets the URL when the pane that announced it dies', async () => {
    emitData(pane.id, VITE_LINE)
    expect(await devServerUrl(PROJECT_SLUG)).toBe(ANNOUNCED_URL)

    emitExit(pane, 0, 'exited')
    await settle()

    expect(await devServerUrl(PROJECT_SLUG)).toBeNull()
  })

  // A detach is not a death: the tmux session and whatever is serving inside
  // it both outlive the client, so the URL is still the truth. This is what
  // the clearing above has to be guarded by, and the pair of tests is what
  // separates the guard from an unconditional forget.
  it('keeps the URL when the session outlived its client', async () => {
    emitData(pane.id, VITE_LINE)

    emitExit(pane, 0, 'detached')
    await settle()

    expect(await devServerUrl(PROJECT_SLUG)).toBe(ANNOUNCED_URL)
  })
})
