import { dialog, ipcMain, type BrowserWindow } from 'electron'
import {
  CHANNELS,
  type Candidate,
  type OpenRequest,
  type Preset,
  type ProjectDescriptor,
  type RestartRequest,
  type RestoreResult,
  type StatusEvent,
  type TabDescriptor,
} from '../../shared/ipc'
import type { ExitReason, SessionManager, TabRecord } from '../sessions/manager'
import { ConfigStore, type PrcliConfig } from '../state/store'
import { StatusRegistry } from '../status/registry'
import { describeProjects, restoreWorkspace, withUnsorted } from './restore'
import { isDirectory } from '../fsutil'
import { scanCandidates } from '../projects/discovery'
import {
  addProject,
  projectForSlug,
  removeProject,
  reorderProjects,
  updateProject,
} from '../projects/projects'

export function registerIpc(
  manager: SessionManager,
  getWindow: () => BrowserWindow | null,
  registry: StatusRegistry,
  store: ConfigStore = new ConfigStore(ConfigStore.defaultPath()),
  // Told rather than asked: `register.ts` is constructed by `index.ts`, and an
  // import back the other way to reach `setAttendedTab` directly would be a
  // cycle. A no-op default keeps every existing caller — and every test —
  // working unchanged.
  onActiveTabChanged: (id: string | null) => void = () => undefined,
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

  // The size each tab's client last reported.
  //
  // Restart is a new attach path, and every new attach path in this codebase
  // has shipped with the same defect: attach at the 80×24 default and tmux,
  // seeing its only client, resizes the window down and SIGWINCHes whatever is
  // inside — permanently reflowing the user's scrollback. The manager keeps
  // geometry on its `Entry`, but the entry is deleted when the session dies,
  // which is precisely when Restart needs it. So it is remembered here too.
  const lastGeometry = new Map<string, { cols: number; rows: number }>()

  registry.onTransition(({ tabId, to }) => {
    const payload: StatusEvent = { tabId, state: to }
    send(CHANNELS.statusChanged, payload)
  })

  ipcMain.handle(CHANNELS.status, () => registry.snapshot())

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
      if (!sessionAlive) {
        // `killed` is never pruned here: the CHANNELS.kill handler below
        // already owns that, and forgets the tab immediately after the same
        // `manager.kill()` this resolved against has succeeded — pruning here
        // too would only be a redundant second write of the same outcome.
        if (reason === 'exited') await forgetTab(record.id)
        // A deliberate kill already owns the registry state too: the
        // CHANNELS.kill handler below calls `registry.forget` once its own
        // await on the very same promise settles. Recording a tombstone here
        // as well races that forget with no ordering guarantee — whichever
        // runs last wins, and a `forget` that loses would leak a
        // `crashed`/`ended` entry for a tab already gone from config and the
        // tab bar, with nothing left that would ever call `forget` again to
        // clean it up. A kill the user asked for does not need a tombstone —
        // they already know it is gone.
        if (reason !== 'killed') registry.applyExit(record.id, code)
      }
    })()
  })

  ipcMain.handle(CHANNELS.open, async (_event, request: OpenRequest): Promise<TabDescriptor> => {
    // node-pty does not throw on a missing cwd — it yields a live process that
    // produces nothing, so the tab renders permanently blank while its tmux
    // session is perfectly fine. Say what is actually wrong instead.
    if (!(await isDirectory(request.cwd))) {
      throw new Error(`Cannot open a terminal: ${request.cwd} is not a directory`)
    }
    const record = manager.open(request)
    await rememberTab(record)
    registry.applyOpen(record.id, record.type)
    return record
  })

  ipcMain.handle(CHANNELS.list, (): TabDescriptor[] => manager.list())

  // The reconcile reads and then writes, so it has to hold the queue for the
  // whole operation rather than racing an `open` or an exit between the two.
  ipcMain.handle(CHANNELS.restore, async (): Promise<RestoreResult> => {
    const result = await restoreWorkspace(manager, store, serialise)
    // restoreWorkspace reattaches every tab through `manager.open` directly,
    // never through the CHANNELS.open handler above — so nothing else ever
    // gives a restored tab an initial state. Left alone, a relaunched
    // `claude` tab would show no dot at all rather than the hollow `unknown`
    // one deserves, indistinguishable from a shell nothing has run in.
    //
    // Restore is also how a mid-session renderer reload (⌘R) re-fetches the
    // workspace, and by then the registry already knows real states from
    // hook events main never stopped receiving. Only a tab the registry has
    // never seen gets initialised here — that is what keeps ⌘R from
    // stamping a live `waiting`/`thinking` tab back to `unknown`.
    for (const tab of result.tabs) {
      if (registry.get(tab.id) === null) registry.applyOpen(tab.id, tab.type)
    }
    return result
  })

  /**
   * The project list a mutation answers with — Unsorted included.
   *
   * Restore is the only other place that builds this, and it builds it the same
   * way, so a mutation and a relaunch cannot disagree. Skipping the Unsorted row
   * here would mean a removed project's still-running sessions dropped off the
   * screen until the next launch, which is the opposite of leaving them alive
   * and reachable.
   *
   * The tab set is config's, not the manager's. A detached tab stays in the tab
   * bar — its session is running and only its client is gone — so describing
   * against live clients alone would drop the Unsorted row such a tab needs.
   * Every caller below runs inside the write queue, where config's tab list is a
   * superset of the manager's: an `open` records its tab through the same queue
   * before anything else can read it.
   */
  const described = async (config: PrcliConfig): Promise<ProjectDescriptor[]> =>
    withUnsorted(await describeProjects(config.projects, config.tabs), config.tabs)

  ipcMain.on(CHANNELS.setActive, (_event, id: string | null) => {
    // Read directly, never through `serialise`: the queue has no reentrancy
    // protection, and this callback is what the router's `isAttended` reads
    // on every transition. Anything downstream of it calling back into
    // `serialise` would deadlock the queue silently.
    onActiveTabChanged(id)
    void serialise(async () => {
      if (id === null) return
      const config = await store.read()
      const tab = config.tabs.find((saved) => saved.id === id)
      if (!tab) return
      const owner = projectForSlug(config, tab.projectSlug)
      // A tab under Unsorted has no row to record this on, by design.
      if (!owner) return
      await store.write({
        ...config,
        projects: config.projects.map((project) =>
          project.id === owner.id ? { ...project, activeTabId: id } : project,
        ),
      })
    })
  })

  ipcMain.on(CHANNELS.setActiveProject, (_event, id: string | null) => {
    void serialise(async () => {
      const config = await store.read()
      await store.write({ ...config, activeProjectId: id })
    })
  })

  ipcMain.handle(CHANNELS.addProject, (_event, input: { name: string; cwd: string }) =>
    serialise(async () => {
      const { config } = addProject(await store.read(), input)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(
    CHANNELS.updateProject,
    (_event, id: string, patch: { name?: string; presets?: Preset[] }) =>
      serialise(async () => {
        const config = updateProject(await store.read(), id, patch)
        await store.write(config)
        return described(config)
      }),
  )

  ipcMain.handle(CHANNELS.removeProject, (_event, id: string) =>
    serialise(async () => {
      // The project's sessions keep running. They stop matching a project and
      // surface under Unsorted, so nothing is stranded and nothing is killed.
      const config = removeProject(await store.read(), id)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(CHANNELS.reorderProjects, (_event, ids: string[]) =>
    serialise(async () => {
      const config = reorderProjects(await store.read(), ids)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(CHANNELS.scanCandidates, async (): Promise<Candidate[]> => {
    const config = await store.read()
    return scanCandidates(config.projects.map((project) => project.cwd))
  })

  ipcMain.handle(CHANNELS.pickFolder, async (): Promise<string | null> => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(CHANNELS.moveTabToProject, (_event, tabId: string, projectId: string) =>
    serialise(async () => {
      const config = await store.read()
      const target = config.projects.find((project) => project.id === projectId)
      if (!target) throw new Error(`moveTabToProject: no project ${projectId}`)

      // Renames the tmux session, so this either moves the tab or throws —
      // there is no half-applied outcome to unpick here. The saved row goes
      // along because a tab whose client has gone is found through
      // `findOrphans`, which has to synthesise a cwd; config holds the real one.
      const saved = config.tabs.find((row) => row.id === tabId)
      const tab = await manager.moveToProject(tabId, target.slug, saved)
      // Replace in place where config already lists the tab, so the tab bar
      // keeps its order; append where it does not. A plain `map` would quietly
      // drop the new record for a tab config had never written — the invariant
      // that restore always writes one first holds on every path this milestone
      // exercises, but it is an invariant, not a guarantee, and the cost of it
      // failing is a session running under a name nothing on disk knows. This
      // invents nothing: the rename above succeeded, so the session is there.
      const tabs = saved
        ? config.tabs.map((row) => (row.id === tabId ? tab : row))
        : [...config.tabs, tab]
      const updated: PrcliConfig = { ...config, tabs }
      await store.write(updated)
      return { projects: await described(updated), tab }
    }),
  )

  ipcMain.on(CHANNELS.input, (_event, id: string, data: string) => manager.write(id, data))

  ipcMain.on(CHANNELS.resize, (_event, id: string, cols: number, rows: number) => {
    // Same guard the manager applies, so a rejected size is never remembered
    // as the one a restart should attach at.
    if (cols >= 1 && rows >= 1) lastGeometry.set(id, { cols, rows })
    manager.resize(id, cols, rows)
  })

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
      registry.forget(id)
      lastGeometry.delete(id)
    } finally {
      pendingKills.delete(id)
    }
  })

  ipcMain.handle(
    CHANNELS.restartTab,
    async (_event, request: RestartRequest): Promise<TabDescriptor> => {
      const { tab } = request
      // Same guard `open` applies: node-pty does not throw on a missing cwd,
      // it yields a live process that produces nothing, so the tab comes back
      // permanently blank while looking fine.
      if (!(await isDirectory(tab.cwd))) {
        throw new Error(`Cannot restart: ${tab.cwd} is not a directory`)
      }
      const remembered = lastGeometry.get(tab.id)
      const record = manager.open({
        id: tab.id,
        projectSlug: tab.projectSlug,
        cwd: tab.cwd,
        command: tab.command,
        type: tab.type,
        // The renderer's live measurement first, the last one main saw
        // second. Attaching at neither would let tmux shrink the recreated
        // session to 80×24 — the defect this codebase has now shipped twice.
        cols: request.cols ?? remembered?.cols,
        rows: request.rows ?? remembered?.rows,
      })
      await rememberTab(record)
      registry.applyOpen(record.id, record.type)
      return record
    },
  )

  ipcMain.on(CHANNELS.dismissTab, (_event, id: string) => {
    // The row is already gone from config — the exit handler forgot it. This
    // drops the state, so the dock badge stops counting a tab nobody can see.
    registry.forget(id)
    lastGeometry.delete(id)
  })
}
