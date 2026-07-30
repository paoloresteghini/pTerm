import { ipcMain, type BrowserWindow } from 'electron'
import { CHANNELS, type OpenRequest, type TabDescriptor } from '../../shared/ipc'
import type { SessionManager } from '../sessions/manager'
import { ConfigStore } from '../state/store'

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

  manager.onData((id, data) => send(CHANNELS.data, { id, data }))
  manager.onExit((id, code, reason) => {
    send(CHANNELS.exit, { id, code })
    // A detach leaves the tmux session running, so the record must survive it.
    // Anything else means the session is gone and the record is stale.
    if (reason !== 'detached') void forgetTab(id)
  })

  ipcMain.handle(CHANNELS.open, async (_event, request: OpenRequest): Promise<TabDescriptor> => {
    const record = manager.open(request)
    await rememberTab(record)
    return record
  })

  ipcMain.handle(CHANNELS.list, (): TabDescriptor[] => manager.list())

  ipcMain.handle(CHANNELS.restore, async (): Promise<TabDescriptor[]> => {
    const saved = await store.read()
    const orphans = await manager.findOrphans()
    const alive = new Set(orphans.map((orphan) => orphan.tmuxSession))
    const restored: TabDescriptor[] = []
    for (const tab of saved.tabs) {
      // Only reattach tabs whose tmux session actually still exists.
      if (!alive.has(tab.tmuxSession)) continue
      restored.push(
        manager.open({
          id: tab.id,
          projectSlug: tab.projectSlug,
          cwd: tab.cwd,
          command: tab.command,
          tmuxSession: tab.tmuxSession,
        }),
      )
    }
    return restored
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
