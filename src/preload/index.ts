import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CHANNELS,
  type DataEvent,
  type DiffSide,
  type ExitEvent,
  type GitChanges,
  type GitMutation,
  type GitStatus,
  type GitSyncResult,
  type MenuCommand,
  type OpenRequest,
  type PTermApi,
  type StatusEvent,
  type TabDescriptor,
  type UpdateCheckResult,
  type UpdateInfo,
} from '../shared/ipc'

const api: PTermApi = {
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
  renameTab: (id, title) => ipcRenderer.invoke(CHANNELS.renameTab, id, title),
  setPaneColor: (id, color) => ipcRenderer.invoke(CHANNELS.setPaneColor, id, color),
  input: (id, data) => ipcRenderer.send(CHANNELS.input, id, data),
  resize: (id, cols, rows) => ipcRenderer.send(CHANNELS.resize, id, cols, rows),
  detach: (id) => ipcRenderer.send(CHANNELS.detach, id),
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
  acknowledgeTab: (id) => ipcRenderer.send(CHANNELS.acknowledgeTab, id),
  splitPane: (request) => ipcRenderer.invoke(CHANNELS.splitPane, request),
  closePane: (paneId) => ipcRenderer.invoke(CHANNELS.closePane, paneId),
  onFocusTab: (listener: (tabId: string) => void) => {
    const handler = (_event: IpcRendererEvent, tabId: string): void => listener(tabId)
    ipcRenderer.on(CHANNELS.focusTab, handler)
    return () => ipcRenderer.removeListener(CHANNELS.focusTab, handler)
  },
  onMenuCommand: (listener: (command: MenuCommand) => void) => {
    const handler = (_event: IpcRendererEvent, command: MenuCommand): void => listener(command)
    ipcRenderer.on(CHANNELS.menuCommand, handler)
    return () => ipcRenderer.removeListener(CHANNELS.menuCommand, handler)
  },
  notifications: () => ipcRenderer.invoke(CHANNELS.notifications),
  updateNotifications: (patch) => ipcRenderer.invoke(CHANNELS.updateNotifications, patch),
  hooksState: () => ipcRenderer.invoke(CHANNELS.hooksState),
  installHooks: () => ipcRenderer.invoke(CHANNELS.installHooks),
  uninstallHooks: () => ipcRenderer.invoke(CHANNELS.uninstallHooks),
  historyList: (projectCwd, scope) => ipcRenderer.invoke(CHANNELS.historyList, projectCwd, scope),
  shellHistoryState: () => ipcRenderer.invoke(CHANNELS.shellHistoryState),
  installShellHistory: () => ipcRenderer.invoke(CHANNELS.installShellHistory),
  uninstallShellHistory: () => ipcRenderer.invoke(CHANNELS.uninstallShellHistory),
  setLayout: (tabId, shares) => ipcRenderer.send(CHANNELS.setLayout, tabId, shares),
  skills: (projectCwd) => ipcRenderer.invoke(CHANNELS.skills, projectCwd),
  notesRead: (projectId) => ipcRenderer.invoke(CHANNELS.notesRead, projectId),
  notesWrite: (projectId, text) => ipcRenderer.invoke(CHANNELS.notesWrite, projectId, text),
  promptsList: () => ipcRenderer.invoke(CHANNELS.promptsList),
  promptsAdd: (label, body) => ipcRenderer.invoke(CHANNELS.promptsAdd, label, body),
  promptsRemove: (id) => ipcRenderer.invoke(CHANNELS.promptsRemove, id),
  fsList: (projectId, relPath) => ipcRenderer.invoke(CHANNELS.fsList, projectId, relPath),
  fsRead: (projectId, relPath) => ipcRenderer.invoke(CHANNELS.fsRead, projectId, relPath),
  fsWrite: (projectId, relPath, text, expectedMtimeMs) =>
    ipcRenderer.invoke(CHANNELS.fsWrite, projectId, relPath, text, expectedMtimeMs),
  openEditor: (projectId, relPath) => ipcRenderer.invoke(CHANNELS.openEditor, projectId, relPath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CHANNELS.openExternal, url),
  onUpdateAvailable: (listener: (info: UpdateInfo) => void) => {
    const handler = (_event: IpcRendererEvent, payload: UpdateInfo): void => listener(payload)
    ipcRenderer.on(CHANNELS.updateAvailable, handler)
    return () => ipcRenderer.removeListener(CHANNELS.updateAvailable, handler)
  },
  checkForUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(CHANNELS.checkForUpdate),
  skipUpdate: (version: string): Promise<void> => ipcRenderer.invoke(CHANNELS.skipUpdate, version),
  appVersion: (): Promise<string> => ipcRenderer.invoke(CHANNELS.appVersion),
  skippedVersion: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.skippedVersion),
  gitStatus: (projectId: string): Promise<GitStatus | null> =>
    ipcRenderer.invoke(CHANNELS.gitStatus, projectId),
  gitSync: (projectId: string): Promise<GitSyncResult> =>
    ipcRenderer.invoke(CHANNELS.gitSync, projectId),
  gitChanges: (projectId: string): Promise<GitChanges | null> =>
    ipcRenderer.invoke(CHANNELS.gitChanges, projectId),
  gitStage: (projectId: string, paths: string[]): Promise<GitMutation> =>
    ipcRenderer.invoke(CHANNELS.gitStage, projectId, paths),
  gitUnstage: (projectId: string, paths: string[]): Promise<GitMutation> =>
    ipcRenderer.invoke(CHANNELS.gitUnstage, projectId, paths),
  gitCommit: (
    projectId: string,
    message: string,
    expected: { branch: string | null; head: string | null },
  ): Promise<GitMutation> => ipcRenderer.invoke(CHANNELS.gitCommit, projectId, message, expected),
  gitDiscard: (
    projectId: string,
    paths: string[],
    expectedUntracked: string[],
  ): Promise<GitMutation> =>
    ipcRenderer.invoke(CHANNELS.gitDiscard, projectId, paths, expectedUntracked),
  gitStash: (projectId: string): Promise<GitMutation> =>
    ipcRenderer.invoke(CHANNELS.gitStash, projectId),
  gitDiff: (projectId: string, relPath: string, side: DiffSide): Promise<string | null> =>
    ipcRenderer.invoke(CHANNELS.gitDiff, projectId, relPath, side),
  openDiff: (projectId: string, relPath: string, side: DiffSide): Promise<TabDescriptor | null> =>
    ipcRenderer.invoke(CHANNELS.openDiff, projectId, relPath, side),
}

contextBridge.exposeInMainWorld('pterm', api)

export type { TabDescriptor }
