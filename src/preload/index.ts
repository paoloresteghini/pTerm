import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CHANNELS,
  type DataEvent,
  type ExitEvent,
  type OpenRequest,
  type PrcliApi,
  type TabDescriptor,
} from '../shared/ipc'

const api: PrcliApi = {
  open: (request: OpenRequest) => ipcRenderer.invoke(CHANNELS.open, request),
  list: () => ipcRenderer.invoke(CHANNELS.list),
  restore: () => ipcRenderer.invoke(CHANNELS.restore),
  setActive: (id) => ipcRenderer.send(CHANNELS.setActive, id),
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
}

contextBridge.exposeInMainWorld('prcli', api)

export type { TabDescriptor }
