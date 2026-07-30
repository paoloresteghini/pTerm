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

  // `SessionManager.kill()` detaches the local client — which fires the exit
  // event below — before it even knows whether `TmuxAdapter.killSession()`
  // will succeed, and killing the local client is quicker than spawning tmux
  // to destroy the session. So the exit event routinely arrives while the
  // kill is still in flight, and asking tmux fresh at that moment mostly asks
  // a question that hasn't been answered yet: a kill that would go on to
  // succeed can just as well be caught still looking alive. Recording the
  // in-flight kill here lets the exit event wait on the one query that
  // actually settles the question, instead of racing a second one against it.
  const pendingKills = new Map<string, Promise<void>>()

  /**
   * Whether the tmux session outlived the client that just stopped.
   *
   * `detached` is how a session survives on purpose, so that one answers
   * itself. `killed` is answered by the kill already in flight for it, via
   * `pendingKills`, when there is one to ask. `exited` — and a `killed` with
   * no pending kill on record, which should not happen but must still get a
   * real answer rather than an assumed one — asks tmux directly.
   */
  const sessionSurvived = async (record: TabRecord, reason: ExitReason): Promise<boolean> => {
    if (reason === 'detached') return true
    const pending = reason === 'killed' ? pendingKills.get(record.id) : undefined
    if (pending) {
      // `manager.kill()` resolving means `killSession()` succeeded: dead.
      // `killSession()` only throws once it has verified the session is
      // still there (or the verification itself failed, which the shared
      // catch below already treats as "alive" — the safe default).
      try {
        await pending
        return false
      } catch {
        return true
      }
    }
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
    // That makes the send wait on the kill (or on tmux) in the `killed` and
    // `exited` cases — a genuine death still reaches the renderer, one round
    // trip later.
    void (async () => {
      const sessionAlive = await sessionSurvived(record, reason)
      send(CHANNELS.exit, { id: record.id, code, sessionAlive })
      // `killed` is never pruned here: the CHANNELS.kill handler below
      // already owns that, and forgets the tab immediately after the same
      // `manager.kill()` this resolved against has succeeded — pruning here
      // too would only be a redundant second write of the same outcome.
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

  ipcMain.on(CHANNELS.setActive, (_event, _id: string | null) => {
    // Task 8 reinstates this against per-project active tabs.
  })

  ipcMain.on(CHANNELS.input, (_event, id: string, data: string) => manager.write(id, data))

  ipcMain.on(CHANNELS.resize, (_event, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows),
  )

  // No persistence here: detaching is how a session survives, so forgetting it
  // would be exactly the wrong thing to record.
  ipcMain.on(CHANNELS.detach, (_event, id: string) => manager.detach(id))

  ipcMain.handle(CHANNELS.kill, async (_event, id: string) => {
    // Recorded before the first await inside `manager.kill()` can run, so it
    // is always in place before the exit event it settles could possibly
    // fire — see `pendingKills` above.
    const outcome = manager.kill(id)
    pendingKills.set(id, outcome)
    try {
      await outcome
      await forgetTab(id)
    } finally {
      pendingKills.delete(id)
    }
  })
}
