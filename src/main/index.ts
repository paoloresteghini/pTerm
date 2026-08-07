import { app, BrowserWindow, dialog, ipcMain, Menu, Notification } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { TmuxAdapter, TmuxNotInstalledError } from './tmux/adapter'
import { resolveTmuxBin } from './tmux/resolve'
import { SessionManager } from './sessions/manager'
import { registerIpc } from './ipc/register'
import { StatusRegistry } from './status/registry'
import { createHookInbox } from './status/inbox'
import { mergeTab, NotificationRouter } from './notify/router'
import { ConfigStore } from './state/store'
import { HookServer } from './hooks/server'
import { hookPaths, writeScript } from './hooks/install'
import {
  CHANNELS,
  columnIsCollapsed,
  type ColumnId,
  type ColumnVisibility,
  type MenuCommand,
} from '../shared/ipc'
import { scheduleUpdateChecks } from './update/schedule'

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

let mainWindow: BrowserWindow | null = null

/**
 * Set by the e2e harness, and by nothing else.
 *
 * A run launches this app 130+ times. With this on, none of those launches
 * shows a window, takes an icon in the dock, or posts a notification, so a
 * suite can run while its developer keeps working. Read once here rather than
 * per call: the harness sets it before launch and nothing changes it after.
 */
const backgroundWindow = process.env.PTERM_BACKGROUND_WINDOW === '1'

// `PTERM_TMUX_SOCKET` exists so tests run against their own tmux server and can
// never see, adopt or kill the user's real sessions.
// tmux is resolved to an absolute path because a Finder/Dock launch inherits
// launchd's PATH, which has no Homebrew in it.
const adapter = new TmuxAdapter({
  bin: resolveTmuxBin(),
  socket: process.env.PTERM_TMUX_SOCKET,
})
// Every session tmux opens gets a `pane-died` hook pointing at this script,
// which is how a command that exits non-zero reaches the app as a crash rather
// than as the code 0 an attached client always reports. `hookPaths()` reads
// `PTERM_CONFIG_DIR` at call time, so a test's sessions point at the test's
// own copy.
const manager = new SessionManager(adapter, { deathReporter: hookPaths().script })
const registry = new StatusRegistry()
const store = new ConfigStore(ConfigStore.defaultPath())

/**
 * Where hook events actually arrive from Claude Code, one JSON line per event.
 *
 * Constructed here, alongside the registry it feeds, rather than inside
 * `registerIpc`: it must already be listening before the renderer's first
 * `restore` call, or an event that fires in the gap between launch and that
 * call would have nowhere to land but the spool. `hookPaths()` reads
 * `PTERM_CONFIG_DIR` at call time, same as `ConfigStore.defaultPath()` above.
 */
const hookServer = new HookServer(hookPaths().socket)
// Which events are admitted, and in what order, is `inbox.ts`'s business —
// both rules are written down there, next to the tests that hold them. This
// file only supplies the two things it cannot know: who is attached right now,
// and what is on disk.
const inbox = createHookInbox({
  registry,
  isOpen: (tabId) => manager.get(tabId) !== undefined,
  // Panes: a hook fires from inside one session, and it is a pane row that
  // carries the session name and slug the inbox matches it against. Config's
  // tab rows hold layout and nothing a hook can be resolved against.
  readTabs: async () => (await store.read()).panes,
})
hookServer.onEvent((message) => void inbox.handle(message))

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
    return mergeTab(manager.get(tabId) ?? null, config.panes, tabId)
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
    // Nothing a test run does may interrupt the developer it is running on.
    // The window is hidden for a run, so `isAttended` is false for every tab
    // and the mute rules that would normally swallow these no longer fire: a
    // suite that drives dozens of `waiting` transitions would otherwise post
    // dozens of real banners over whatever they are working on.
    //
    // Measured 2026-08-06 by counting calls on both sides of this line during
    // one run of `status.spec.ts`: 10 toasts attempted, 0 shown. Thirteen
    // tests in one of twenty spec files, so the suite was posting real
    // banners by the hundred.
    //
    // The cost, stated rather than glossed: `notification.show()` and the
    // click handler below are then unreached in e2e. No spec asserted either
    // (the suite reads the dock badge, never a toast), so nothing loses
    // coverage it had, but nothing gains it here either.
    if (backgroundWindow) return
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
    // Same reason as `showToast` above. Sounds are off in the default rules a
    // spec seeds, so today this guard is belt and braces rather than the thing
    // that keeps a run quiet, but a spec that seeds a rule with a sound would
    // otherwise play it out loud on the developer's machine.
    if (backgroundWindow) return
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

// The renderer owns ⌘T, ⌘W, ⇧⌘\, ⌘D, ⇧⌘D and the ⌘⌥arrows: they act on tabs,
// on panes and on the presets panel. A menu accelerator fires instead of
// whatever the renderer does with the event, so the default File menu's
// "Close Window" would win and take every session's client down with it — and
// the pane bindings would take their keystrokes off whatever is running in the
// pane, which here is usually Claude.
// Same menu as Electron's default, with those items' accelerators shown but
// not registered.
/**
 * Ask the renderer to carry out a clicked menu item.
 *
 * The accelerators stay unregistered so the keystroke reaches the renderer's
 * own handler — that was always right. What was missing is that *clicking* the
 * item did nothing, because the renderer owns every one of these actions and
 * main had no way to ask for one.
 */
function sendMenuCommand(command: MenuCommand): void {
  mainWindow?.webContents.send(CHANNELS.menuCommand, command)
}

/**
 * Show the renderer's column state on the View menu.
 *
 * By id rather than by rebuilding the template: a rebuild would re-create
 * every item on every column toggle, and the ids already exist for the tests
 * to click through.
 */
function showColumns(collapsed: ColumnVisibility): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const ids: Record<ColumnId, string> = {
    files: 'toggle-files',
    skills: 'toggle-skills',
    presets: 'toggle-presets',
    prompts: 'toggle-prompts',
    notes: 'toggle-notes',
    git: 'toggle-git',
  }
  let open = false
  for (const [column, itemId] of Object.entries(ids) as [ColumnId, string][]) {
    const shut = columnIsCollapsed(collapsed, column)
    if (!shut) open = true
    const item = menu.getMenuItemById(itemId)
    if (item) item.checked = !shut
  }
  const all = menu.getMenuItemById('hide-all-columns')
  if (all) all.label = open ? 'Hide All Columns' : 'Show All Columns'
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          // Ids exist so a test can click these without driving the macOS
          // menu bar, which Playwright cannot reach.
          id: 'new-tab',
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          registerAccelerator: false,
          click: () => sendMenuCommand('newTab'),
        },
        {
          // Pane, not tab: ⌘W closes the pane that is listening, and takes
          // the tab with it only when that was the tab's last one. The old
          // label was true right up until a tab could hold two panes.
          id: 'close-pane',
          label: 'Close Pane',
          accelerator: 'CmdOrCtrl+W',
          // Displayed, but not claimed from the system — the keystroke
          // reaches the renderer instead.
          registerAccelerator: false,
          click: () => sendMenuCommand('closePane'),
        },
        { type: 'separator' },
        {
          id: 'settings',
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          registerAccelerator: false,
          click: () => sendMenuCommand('settings'),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          id: 'toggle-files',
          label: 'Files',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+F',
          registerAccelerator: false,
          click: () => sendMenuCommand('toggleFiles'),
        },
        {
          id: 'toggle-skills',
          label: 'Skills',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+S',
          registerAccelerator: false,
          click: () => sendMenuCommand('toggleSkills'),
        },
        {
          id: 'toggle-presets',
          label: 'Presets',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+P',
          registerAccelerator: false,
          click: () => sendMenuCommand('togglePresets'),
        },
        {
          id: 'toggle-prompts',
          label: 'Prompts',
          type: 'checkbox',
          // One modifier away from `reload`'s CmdOrCtrl+R, and distinct from
          // it. Taken so the six letters stay mnemonic: P is spent on Presets,
          // and one non-mnemonic key among six is harder to remember than a
          // near miss.
          accelerator: 'Alt+CmdOrCtrl+R',
          registerAccelerator: false,
          click: () => sendMenuCommand('togglePrompts'),
        },
        {
          id: 'toggle-git',
          label: 'Git',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+G',
          registerAccelerator: false,
          click: () => sendMenuCommand('toggleGit'),
        },
        {
          id: 'toggle-notes',
          label: 'Notes',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+N',
          registerAccelerator: false,
          click: () => sendMenuCommand('toggleNotes'),
        },
        { type: 'separator' },
        {
          id: 'hide-all-columns',
          // Relabelled from main whenever the renderer reports its columns,
          // so it never claims to do the opposite of what it will do.
          label: 'Hide All Columns',
          accelerator: 'Shift+CmdOrCtrl+\\',
          registerAccelerator: false,
          click: () => sendMenuCommand('hideAllColumns'),
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
    {
      label: 'Pane',
      submenu: [
        {
          id: 'split-right',
          label: 'Split Right',
          accelerator: 'CmdOrCtrl+D',
          registerAccelerator: false,
          click: () => sendMenuCommand('splitRight'),
        },
        {
          id: 'split-down',
          label: 'Split Down',
          accelerator: 'Shift+CmdOrCtrl+D',
          registerAccelerator: false,
          click: () => sendMenuCommand('splitDown'),
        },
        // A disabled line used to sit here reading "A tab keeps the axis of its
        // first split". It existed because the two items above did the same
        // thing on an already-split tab and there was nowhere else to say so.
        // Both items now do what they say on every tab, so the explanation has
        // nothing left to explain. See `SplitRequest.dir`.
        { type: 'separator' },
        {
          id: 'focus-left',
          label: 'Focus Left',
          accelerator: 'CmdOrCtrl+Alt+Left',
          registerAccelerator: false,
          click: () => sendMenuCommand('focusLeft'),
        },
        {
          id: 'focus-right',
          label: 'Focus Right',
          accelerator: 'CmdOrCtrl+Alt+Right',
          registerAccelerator: false,
          click: () => sendMenuCommand('focusRight'),
        },
        {
          id: 'focus-up',
          label: 'Focus Up',
          accelerator: 'CmdOrCtrl+Alt+Up',
          registerAccelerator: false,
          click: () => sendMenuCommand('focusUp'),
        },
        {
          id: 'focus-down',
          label: 'Focus Down',
          accelerator: 'CmdOrCtrl+Alt+Down',
          registerAccelerator: false,
          click: () => sendMenuCommand('focusDown'),
        },
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
  // A full e2e run launches this app hundreds of times, and each launch
  // otherwise opens in the middle of the developer's screen and takes key
  // focus, which makes the machine unusable for the length of the run. The
  // harness sets this so the window is never shown at all.
  //
  // Not moved off screen, which was tried first and does not work: macOS
  // clamps a window's frame back onto a display. Measured 2026-08-06 on a
  // 5120x1440 screen, created at y=1540 it came back at y=564, and
  // `setPosition(-5000, 3000)` came back as x=-1240, y=1332, a window still
  // showing a 40x800 sliver.
  //
  // A window that is never shown keeps painting: measured the same day,
  // 289 `requestAnimationFrame` callbacks in 2s either way, with
  // `document.visibilityState` still `visible`. That matters because xterm
  // draws on rAF, and the specs read what it drew.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !backgroundWindow,
    backgroundColor: '#09090b',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // No dock icon and no app switcher entry either: hundreds of launches
  // bouncing in the dock is the other half of what makes a run unusable.
  if (backgroundWindow) app.dock?.hide()

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
        'pTerm could not find tmux.\n\nInstall it with:\n    brew install tmux\n\n' +
          'If tmux is installed somewhere unusual, set PTERM_TMUX_BIN to its full path.',
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
    // Unconditionally, not only behind the Claude hooks gesture: tmux runs
    // this to report a crashed pane, and a crashed `npm run dev` has nothing
    // to do with Claude. See `writeScript`.
    await writeScript()
    await hookServer.start()
  } catch (error) {
    console.error('pTerm: failed to start the hook server', error)
  }

  installMenu()
  ipcMain.on(CHANNELS.columnsVisible, (_event, collapsed: ColumnVisibility) => {
    showColumns(collapsed)
  })

  registerIpc(manager, () => mainWindow, registry, store, setAttendedTab, () =>
    router.refreshBadge(),
  )
  createWindow()
  scheduleUpdateChecks(() => mainWindow)

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
