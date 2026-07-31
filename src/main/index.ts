import { app, BrowserWindow, dialog, Menu, Notification } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { TmuxAdapter, TmuxNotInstalledError } from './tmux/adapter'
import { resolveTmuxBin } from './tmux/resolve'
import { SessionManager } from './sessions/manager'
import { registerIpc } from './ipc/register'
import { StatusRegistry } from './status/registry'
import { mergeTab, NotificationRouter } from './notify/router'
import { ConfigStore } from './state/store'
import { HookServer } from './hooks/server'
import { hookPaths } from './hooks/install'
import { CHANNELS } from '../shared/ipc'

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

let mainWindow: BrowserWindow | null = null

// `PRCLI_TMUX_SOCKET` exists so tests run against their own tmux server and can
// never see, adopt or kill the user's real sessions.
// tmux is resolved to an absolute path because a Finder/Dock launch inherits
// launchd's PATH, which has no Homebrew in it.
const adapter = new TmuxAdapter({
  bin: resolveTmuxBin(),
  socket: process.env.PRCLI_TMUX_SOCKET,
})
const manager = new SessionManager(adapter)
const registry = new StatusRegistry()
const store = new ConfigStore(ConfigStore.defaultPath())

/**
 * Where hook events actually arrive from Claude Code, one JSON line per event.
 *
 * Constructed here, alongside the registry it feeds, rather than inside
 * `registerIpc`: it must already be listening before the renderer's first
 * `restore` call, or an event that fires in the gap between launch and that
 * call would have nowhere to land but the spool. `hookPaths()` reads
 * `PRCLI_CONFIG_DIR` at call time, same as `ConfigStore.defaultPath()` above.
 */
const hookServer = new HookServer(hookPaths().socket)
hookServer.onEvent((message) => registry.applyHook(message))

/** The tab the renderer last said was selected — half of "attended". */
let attendedTabId: string | null = null
function setAttendedTab(id: string | null): void {
  attendedTabId = id
}

const router = new NotificationRouter({
  // Read directly, never through the IPC write queue in `register.ts`: that
  // queue has no reentrancy protection, and a transition can fire from
  // anywhere at any time. Going through it here would risk a silent deadlock
  // for something a lost toast should never be able to cause.
  readConfig: async () => (await store.read()).notifications,
  findTab: async (tabId) => {
    // `manager.get` only knows about tabs with a client attached in this app
    // right now. Detaching is how a session survives, not how it ends — the
    // tmux session, and whatever is running inside it, keeps going and still
    // fires hooks with no client on it at all (window closed, a project move
    // mid-flight). Falling back to the saved row, which a detach never
    // removes, is what keeps that tab's transitions routed rather than
    // silently dropped exactly when the dock badge is the only signal left.
    const config = await store.read()
    return mergeTab(manager.get(tabId) ?? null, config.tabs, tabId)
  },
  projectOf: async (tab) => {
    const config = await store.read()
    const project = config.projects.find((candidate) => candidate.slug === tab.projectSlug)
    return project ? { id: project.id, name: project.name } : null
  },
  // Both halves: the window has focus *and* this is the tab on screen. A
  // background tab going `waiting` still toasts while the window is focused,
  // which at twelve sessions is the common case.
  isAttended: (tabId) => mainWindow?.isFocused() === true && attendedTabId === tabId,
  showToast: (toast) => {
    const notification = new Notification({
      title: toast.title,
      body: toast.body,
      // Sound is played separately through afplay, so the rules engine's
      // choice is the only thing that makes noise.
      silent: true,
    })
    notification.on('click', () => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      // `focus()` alone does not reliably bring the app forward on macOS —
      // the same open note the second-instance handler carries.
      app.focus({ steal: true })
      mainWindow.webContents.send(CHANNELS.focusTab, toast.tabId)
    })
    notification.show()
  },
  playSound: (sound) => {
    // Fire and forget: a missing sound file must not throw into a transition.
    execFile('/usr/bin/afplay', [`/System/Library/Sounds/${sound}.aiff`], () => undefined)
  },
  setBadge: (count) => {
    app.dock?.setBadge(count === null ? '' : String(count))
  },
  waitingCount: () => registry.waitingCount(),
  now: () => new Date(),
})

registry.onTransition((transition) => void router.handle(transition))

// Two instances would each open their own sessions and race on one config
// file. Real usage hit exactly that: three stray sessions, none reachable
// from the UI.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
}

// The renderer owns ⌘T, ⌘W and ⇧⌘\: they act on tabs and on the presets
// panel. A menu accelerator fires instead of whatever the renderer does with
// the event, so the default File menu's "Close Window" would win and take
// every session's client down with it.
// Same menu as Electron's default, with those items' accelerators shown but
// not registered.
function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          registerAccelerator: false,
          click: () => undefined,
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          // Displayed, but not claimed from the system — the keystroke
          // reaches the renderer instead.
          registerAccelerator: false,
          click: () => undefined,
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          registerAccelerator: false,
          click: () => undefined,
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Presets',
          accelerator: 'Shift+CmdOrCtrl+\\',
          registerAccelerator: false,
          click: () => undefined,
        },
        { type: 'separator' },
        // `reload` stays: restore reattaches everything, so a reload is how a
        // wedged window recovers its workspace.
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('second-instance', () => {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#09090b',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    )
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    // On macOS the app outlives its window. Detaching here hands the sessions
    // back as orphans, so reopening takes the normal reattach path instead of
    // leaving them attached, invisible and duplicated by a fresh open.
    manager.detachAll()
  })
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return
  try {
    await adapter.version()
  } catch (error) {
    if (error instanceof TmuxNotInstalledError) {
      // A console.error is invisible when the app is launched from Finder or
      // the Dock, which is exactly when tmux is most likely to be missing.
      // Milestone 4 replaces this with a proper onboarding screen.
      dialog.showErrorBox(
        'tmux is required',
        'PRCLI could not find tmux.\n\nInstall it with:\n    brew install tmux\n\n' +
          'If tmux is installed somewhere unusual, set PRCLI_TMUX_BIN to its full path.',
      )
      app.exit(1)
      return
    }
    throw error
  }

  // A hook script or a hand-crafted test client can connect the moment this
  // resolves. A failure here (an unwritable config dir, a path too long for a
  // unix socket) must not stop the app from opening a terminal — the cost is
  // every dot staying hollow until it is fixed, not a broken app.
  try {
    await mkdir(hookPaths().dir, { recursive: true })
    await hookServer.start()
  } catch (error) {
    console.error('PRCLI: failed to start the hook server', error)
  }

  installMenu()

  registerIpc(manager, () => mainWindow, registry, store, setAttendedTab)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Detach every client on quit. tmux sessions keep running by design.
app.on('before-quit', () => {
  manager.detachAll()
  void hookServer.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
