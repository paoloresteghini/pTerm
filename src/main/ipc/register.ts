import { ipcMain, type BrowserWindow } from 'electron'
import { CHANNELS, type OpenRequest, type RestoreResult, type TabDescriptor } from '../../shared/ipc'
import type { ExitReason, SessionManager, TabRecord } from '../sessions/manager'
import { ConfigStore } from '../state/store'
import { restoreWorkspace } from './restore'

export function registerIpc(
  manager: SessionManager,
  getWindow: () => BrowserWindow | null,
  store: ConfigStore = new ConfigStore(ConfigStore.defaultPath()),
): void {
  // The saved tab list means "reattach these next launch", which is not the
  // same set as "clients attached right now" — a detached tab must stay in it.
  // So every mutation reads, edits and rewrites rather than dumping the
  // manager's registry. The file is tiny; serialising the edits is enough to
  // keep concurrent read-modify-writes from losing one another.
  let tail: Promise<unknown> = Promise.resolve()
  const serialise = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    tail = result.catch(() => undefined)
    return result
  }

  const rememberTab = (tab: TabDescriptor): Promise<void> =>
    serialise(async () => {
      const config = await store.read()
      const tabs = config.tabs.filter((saved) => saved.id !== tab.id)
      tabs.push(tab)
      await store.write({ ...config, tabs })
    })

  const forgetTab = (id: string): Promise<void> =>
    serialise(async () => {
      const config = await store.read()
      const tabs = config.tabs.filter((saved) => saved.id !== id)
      if (tabs.length === config.tabs.length) return
      await store.write({ ...config, tabs })
    })

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  /**
   * Whether the tmux session outlived the client that just stopped.
   *
   * `detached` is how a session survives on purpose and `killed` is us
   * destroying it, so both answer themselves. `exited` is the only case that
   * says nothing either way: `Ctrl-b d`, `tmux detach-client` and a client
   * killed from outside all land there with the session still running. Only
   * tmux can settle that one, so ask it rather than inferring.
   */
  const sessionSurvived = async (record: TabRecord, reason: ExitReason): Promise<boolean> => {
    if (reason === 'detached') return true
    if (reason === 'killed') return false
    try {
      return await manager.hasSession(record.tmuxSession)
    } catch {
      // Could not find out. Answering "alive" keeps a stale row and a stale
      // tab, which costs a line of config and a click; answering "dead" for a
      // live session loses it.
      return true
    }
  }

  manager.onData((id, data) => send(CHANNELS.data, { id, data }))
  manager.onExit((record, code, reason) => {
    // The renderer needs the answer to travel with the event: it draws the
    // tabs, and a tab whose session is still running must stay in the bar.
    // That makes the send wait on tmux in the `exited` case — a genuine death
    // still reaches the renderer, one round trip later.
    void (async () => {
      const sessionAlive = await sessionSurvived(record, reason)
      send(CHANNELS.exit, { id: record.id, code, sessionAlive })
      // `killed` is pruned by the kill handler below, only once the kill has
      // actually succeeded.
      if (reason === 'exited' && !sessionAlive) await forgetTab(record.id)
    })()
  })

  ipcMain.handle(CHANNELS.open, async (_event, request: OpenRequest): Promise<TabDescriptor> => {
    const record = manager.open(request)
    await rememberTab(record)
    return record
  })

  ipcMain.handle(CHANNELS.list, (): TabDescriptor[] => manager.list())

  ipcMain.handle(CHANNELS.restore, (): Promise<RestoreResult> => restoreWorkspace(manager, store))

  ipcMain.on(CHANNELS.setActive, (_event, id: string | null) => {
    void serialise(async () => {
      const config = await store.read()
      await store.write({ ...config, activeTabId: id })
    })
  })

  ipcMain.on(CHANNELS.input, (_event, id: string, data: string) => manager.write(id, data))

  ipcMain.on(CHANNELS.resize, (_event, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows),
  )

  // No persistence here: detaching is how a session survives, so forgetting it
  // would be exactly the wrong thing to record.
  ipcMain.on(CHANNELS.detach, (_event, id: string) => manager.detach(id))

  ipcMain.handle(CHANNELS.kill, async (_event, id: string) => {
    await manager.kill(id)
    await forgetTab(id)
  })
}
