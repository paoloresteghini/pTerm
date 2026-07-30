import { ipcMain, type BrowserWindow } from 'electron'
import { CHANNELS, type OpenRequest, type TabDescriptor } from '../../shared/ipc'
import type { SessionManager } from '../sessions/manager'
import { ConfigStore } from '../state/store'

export function registerIpc(
  manager: SessionManager,
  getWindow: () => BrowserWindow | null,
  store: ConfigStore = new ConfigStore(ConfigStore.defaultPath()),
): void {
  const persist = async (): Promise<void> => {
    await store.write({ version: 1, tabs: manager.list() })
  }

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  manager.onData((id, data) => send(CHANNELS.data, { id, data }))
  manager.onExit((id, code) => {
    send(CHANNELS.exit, { id, code })
    void persist()
  })

  ipcMain.handle(CHANNELS.open, async (_event, request: OpenRequest): Promise<TabDescriptor> => {
    const record = manager.open(request)
    await persist()
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
        }),
      )
    }
    await persist()
    return restored
  })

  ipcMain.on(CHANNELS.input, (_event, id: string, data: string) => manager.write(id, data))

  ipcMain.on(CHANNELS.resize, (_event, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows),
  )

  ipcMain.on(CHANNELS.detach, (_event, id: string) => {
    manager.detach(id)
    void persist()
  })

  ipcMain.handle(CHANNELS.kill, async (_event, id: string) => {
    await manager.kill(id)
    await persist()
  })
}
