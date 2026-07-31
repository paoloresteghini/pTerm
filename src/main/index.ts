import { app, BrowserWindow, dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import { TmuxAdapter, TmuxNotInstalledError } from './tmux/adapter'
import { resolveTmuxBin } from './tmux/resolve'
import { SessionManager } from './sessions/manager'
import { registerIpc } from './ipc/register'

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

  installMenu()

  registerIpc(manager, () => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Detach every client on quit. tmux sessions keep running by design.
app.on('before-quit', () => manager.detachAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
