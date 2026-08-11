import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TabDescriptor } from '../../src/shared/ipc'
import type { ProjectRecord } from '../../src/main/state/store'

// registerIpc reaches for electron's ipcMain, which does not exist outside
// the main process. Capturing the handlers here is the same pattern
// history.test.ts and persistence.test.ts use to drive channels without a
// real Electron host.
//
// `listeners` is separate from `handlers`: `setPaneUrl` is registered with
// `.on`, not `.handle` (see `register.ts`), and persistence.test.ts's mock is
// where this split first appears. `openBrowser` alone never needed it.
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
const { mergeSessionlessPanes } = await import('../../src/main/ipc/sessionlessPanes')

type Store = InstanceType<typeof ConfigStore>

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler(null as never, ...(args as never[])) as Promise<T>
}

function openBrowser(projectId: string, url?: string): Promise<TabDescriptor | null> {
  return invoke<TabDescriptor | null>(CHANNELS.openBrowser, projectId, url)
}

// `setPaneUrl` is `.on`, fire-and-forget, so there is no promise to await:
// the write it triggers runs inside `serialise`'s queue, off the same tick
// this call returns on. `settle` gives that queued write a turn to finish
// before a test reads the config back, the same wait persistence.test.ts
// uses after driving `CHANNELS.setLayout` the same way.
const settle = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function setPaneUrl(paneId: string, url: string): Promise<void> {
  const listener = ipc.listeners.get(CHANNELS.setPaneUrl)
  if (!listener) throw new Error(`no listener registered for ${CHANNELS.setPaneUrl}`)
  listener(null as never, paneId as never, url as never)
  await settle()
}

let configDir: string
let store: Store

/** The one project every test in this file opens a browser pane against. */
function project(): ProjectRecord {
  return {
    id: 'p1',
    name: 'Demo',
    slug: 'demo',
    cwd: configDir,
    presets: [],
    activeTabId: null,
    activeBrowserTabId: null,
  }
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'pterm-openBrowser-'))
  store = new ConfigStore(join(configDir, 'config.json'))
  const empty = await store.read()
  await store.write({ ...empty, projects: [project()] })

  ipc.handlers.clear()
  ipc.listeners.clear()
  const manager = new SessionManager(new TmuxAdapter({ socket: 'pterm-openBrowser-test' }))
  const registry = new StatusRegistry()
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: { send: () => undefined },
  }
  registerIpc(manager, () => fakeWindow as never, registry, store)
})

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true })
})

describe('CHANNELS.openBrowser', () => {
  it('writes a pane row and a tab row that names it, in one write', async () => {
    const pane = await openBrowser('p1', 'localhost:3000')

    expect(pane?.type).toBe('browser')
    expect(pane?.url).toBe('http://localhost:3000')
    expect(pane?.projectSlug).toBe('demo')

    const config = await store.read()
    expect(config.panes.map((row) => row.id)).toContain(pane?.id)

    const row = config.tabs.find((tab) => tab.id === pane?.id)
    expect(row).toBeDefined()
    expect(row?.groupId).toBe(pane?.id)
    expect(row?.activePaneId).toBe(pane?.id)
    expect(row?.layout).toEqual({ dir: 'row', ratio: [1], kids: [pane?.id] })
  })

  it('creates a second pane for a URL already open, unlike openEditor', async () => {
    const first = await openBrowser('p1', 'https://example.com')
    const second = await openBrowser('p1', 'https://example.com')

    expect(second?.id).not.toBe(first?.id)
    const config = await store.read()
    expect(config.panes.filter((row) => row.type === 'browser')).toHaveLength(2)
  })

  it('answers null for a project that does not exist', async () => {
    expect(await openBrowser('nope', 'https://example.com')).toBeNull()
  })

  it('opens about:blank when no url is given', async () => {
    const pane = await openBrowser('p1')
    expect(pane?.url).toBe('about:blank')
  })

  // A distinct input from omitting the argument: this one takes
  // `normaliseUrl`'s null branch (blank after trimming) rather than the
  // handler's own `url === undefined` branch. Both land on the same default,
  // and that agreement is what this pins.
  it('opens about:blank for a whitespace-only url too', async () => {
    const pane = await openBrowser('p1', '   ')
    expect(pane?.url).toBe('about:blank')
  })

  it('survives a restore that live tmux knows nothing about', async () => {
    const pane = await openBrowser('p1', 'https://example.com')
    const config = await store.read()

    const merged = mergeSessionlessPanes({
      livePanes: [],
      liveTabs: [],
      savedPanes: config.panes,
      savedTabs: config.tabs,
    })

    expect(merged.panes.find((row) => row.id === pane?.id)?.url).toBe('https://example.com')
    expect(merged.tabs.find((row) => row.id === pane?.id)).toBeDefined()
  })
})

describe('CHANNELS.setPaneUrl', () => {
  it('moves the saved url and leaves other panes alone', async () => {
    const pane = await openBrowser('p1', 'https://example.com')
    // A second pane the write must not touch: the handler's write is a
    // `config.panes.map(...)` over every row, and a predicate that matched
    // too broadly would silently move this pane's url along with the
    // targeted one.
    const other = await openBrowser('p1', 'https://example.org')
    await setPaneUrl(pane!.id, 'https://example.com/deep')

    const config = await store.read()
    expect(config.panes.find((row) => row.id === pane!.id)?.url).toBe('https://example.com/deep')
    expect(config.panes.find((row) => row.id === other!.id)?.url).toBe('https://example.org')
  })

  // The kind check in the handler, pinned directly: a terminal row has no
  // business gaining a `url` field, even though `normalisePane` would keep
  // one if a stray call ever wrote it.
  it('refuses a pane that is not a browser', async () => {
    const config = await store.read()
    const terminalPaneId = 't1'
    await store.write({
      ...config,
      panes: [
        ...config.panes,
        {
          id: terminalPaneId,
          projectSlug: 'demo',
          cwd: configDir,
          type: 'shell',
          tmuxSession: `pterm-demo-${terminalPaneId}`,
        },
      ],
    })

    const before = await store.read()
    await setPaneUrl(terminalPaneId, 'https://example.com')
    const after = await store.read()
    expect(after.panes).toEqual(before.panes)
  })
})
