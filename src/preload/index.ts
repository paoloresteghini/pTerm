import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CHANNELS,
  type DataEvent,
  type ExitEvent,
  type OpenRequest,
  type PrcliApi,
  type StatusEvent,
  type TabDescriptor,
} from '../shared/ipc'

const api: PrcliApi = {
  open: (request: OpenRequest) => ipcRenderer.invoke(CHANNELS.open, request),
  list: () => ipcRenderer.invoke(CHANNELS.list),
  restore: () => ipcRenderer.invoke(CHANNELS.restore),
  setActive: (id) => ipcRenderer.send(CHANNELS.setActive, id),
  addProject: (input) => ipcRenderer.invoke(CHANNELS.addProject, input),
  updateProject: (id, patch) => ipcRenderer.invoke(CHANNELS.updateProject, id, patch),
  removeProject: (id) => ipcRenderer.invoke(CHANNELS.removeProject, id),
  reorderProjects: (ids) => ipcRenderer.invoke(CHANNELS.reorderProjects, ids),
  setActiveProject: (id) => ipcRenderer.send(CHANNELS.setActiveProject, id),
  scanCandidates: () => ipcRenderer.invoke(CHANNELS.scanCandidates),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
  moveTabToProject: (tabId, projectId) =>
    ipcRenderer.invoke(CHANNELS.moveTabToProject, tabId, projectId),
  input: (id, data) => ipcRenderer.send(CHANNELS.input, id, data),
  resize: (id, cols, rows) => ipcRenderer.send(CHANNELS.resize, id, cols, rows),
  detach: (id) => ipcRenderer.send(CHANNELS.detach, id),
  kill: (id) => ipcRenderer.invoke(CHANNELS.kill, id),
  onData: (listener: (event: DataEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: DataEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.data, handler)
    return () => ipcRenderer.removeListener(CHANNELS.data, handler)
  },
  onExit: (listener: (event: ExitEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: ExitEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.exit, handler)
    return () => ipcRenderer.removeListener(CHANNELS.exit, handler)
  },
  status: () => ipcRenderer.invoke(CHANNELS.status),
  onStatus: (listener: (event: StatusEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: StatusEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.statusChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.statusChanged, handler)
  },
  restartTab: (request) => ipcRenderer.invoke(CHANNELS.restartTab, request),
  dismissTab: (id) => ipcRenderer.send(CHANNELS.dismissTab, id),
  onFocusTab: (listener: (tabId: string) => void) => {
    const handler = (_event: IpcRendererEvent, tabId: string): void => listener(tabId)
    ipcRenderer.on(CHANNELS.focusTab, handler)
    return () => ipcRenderer.removeListener(CHANNELS.focusTab, handler)
  },
  notifications: () => ipcRenderer.invoke(CHANNELS.notifications),
  updateNotifications: (patch) => ipcRenderer.invoke(CHANNELS.updateNotifications, patch),
  hooksState: () => ipcRenderer.invoke(CHANNELS.hooksState),
  installHooks: () => ipcRenderer.invoke(CHANNELS.installHooks),
  uninstallHooks: () => ipcRenderer.invoke(CHANNELS.uninstallHooks),
}

contextBridge.exposeInMainWorld('prcli', api)

export type { TabDescriptor }
