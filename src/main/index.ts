import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { TmuxAdapter, TmuxNotInstalledError } from './tmux/adapter'
import { SessionManager } from './sessions/manager'
import { registerIpc } from './ipc/register'

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

let mainWindow: BrowserWindow | null = null

// `PRCLI_TMUX_SOCKET` exists so tests run against their own tmux server and can
// never see, adopt or kill the user's real sessions.
const adapter = new TmuxAdapter({ socket: process.env.PRCLI_TMUX_SOCKET })
const manager = new SessionManager(adapter)

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
  try {
    await adapter.version()
  } catch (error) {
    if (error instanceof TmuxNotInstalledError) {
      // Milestone 4 replaces this with an onboarding screen.
      console.error('tmux is required. Install it with: brew install tmux')
      app.exit(1)
      return
    }
    throw error
  }

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
