import { dialog, ipcMain, type BrowserWindow } from 'electron'
import {
  CHANNELS,
  type Candidate,
  type DataEvent,
  type ExitEvent,
  type NotificationConfig,
  type OpenRequest,
  type Preset,
  type ProjectDescriptor,
  type RestartRequest,
  type RestoreResult,
  type SplitRequest,
  type StatusEvent,
  type TabDescriptor,
  type TabRow,
  type TabShape,
} from '../../shared/ipc'
import type { ExitReason, SessionManager, PaneRecord } from '../sessions/manager'
import { ConfigStore, type PrcliConfig } from '../state/store'
import { StatusRegistry } from '../status/registry'
import { describeProjects, restoreWorkspace, withUnsorted } from './restore'
import { isDirectory } from '../fsutil'
import { scanCandidates } from '../projects/discovery'
import { hookPaths, installHooks, readHooksState, uninstallHooks } from '../hooks/install'
import { drainSpool } from '../hooks/spool'
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
  // Same reasoning as `onActiveTabChanged`: `NotificationRouter` lives in
  // `index.ts`, and this is only ever called after a spool replay (silent by
  // design — see `CHANNELS.restore` below) so the dock badge does not sit
  // stale until some unrelated tab's next transition happens to refresh it.
  refreshBadge: () => void = () => undefined,
): void {
  // The saved pane list means "reattach these next launch", which is not the
  // same set as "clients attached right now" — a detached pane must stay in it.
  // So every mutation reads, edits and rewrites rather than dumping the
  // manager's registry. The file is tiny; serialising the edits is enough to
  // keep concurrent read-modify-writes from losing one another.
  //
  // Existence lives in `config.panes` and layout in `config.tabs`, and the two
  // are not interchangeable: since v5 a tab row is an axis and its ratios and
  // holds none of the fields a session is reattached from. A handler that
  // reaches for the wrong one type-checks perfectly — a `TabRow` has an `id`
  // too — which is why that is written down here rather than left to be
  // noticed. Every handler that only opens or forgets a pane therefore works in
  // `config.panes` alone. Two below do not: `splitPane` and `closePane` change
  // what a tab HOLDS, and write both arrays in one `store.write` so no reader
  // ever sees a pane no tab lists or a kid naming no pane. `CHANNELS.restore`
  // is the third writer of `config.tabs` and the one that is easy to miss —
  // it does not write the file itself, it hands `serialise` to
  // `restoreWorkspace`, which rebuilds every row from live tmux and writes them
  // with the panes inside this same queue.
  let tail: Promise<unknown> = Promise.resolve()
  const serialise = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    tail = result.catch(() => undefined)
    return result
  }

  const rememberTab = (tab: TabDescriptor): Promise<void> =>
    serialise(async () => {
      const config = await store.read()
      const panes = config.panes.filter((saved) => saved.id !== tab.id)
      panes.push(tab)
      await store.write({ ...config, panes })
    })

  const forgetTab = (id: string): Promise<void> =>
    serialise(async () => {
      const config = await store.read()
      // The pane row, not the tab row. Removing the tab row instead would
      // leave the pane on disk for good — and would type-check, because a
      // `TabRow` has an `id` too. Any layout entry left pointing at this pane
      // is collected by the next `read()`; see `normaliseLayout`.
      const panes = config.panes.filter((saved) => saved.id !== id)
      if (panes.length === config.panes.length) return
      await store.write({ ...config, panes })
    })

  /**
   * `tabs` with the row for `tabId` replaced by `next`, or dropped when `next`
   * is null.
   *
   * Both callers rewrite exactly one row and must leave every other one
   * untouched, and a tab whose last pane has closed has to lose its row rather
   * than keep an empty one — `store.read()` would drop such a row on the way
   * back in anyway, but only after it had been written, which is precisely
   * where an assertion could no longer see it.
   *
   * Replaced in place, never removed-and-appended: array order is the order the
   * tab bar draws, so splitting a pane in the third tab must not move that tab
   * to the end. A row that is not there yet is appended, which is the ordinary
   * case for the first split of a tab opened this run — `CHANNELS.open` writes
   * a pane row and no tab row.
   *
   * Free of `serialise`, `store` and the manager on purpose: the caller is
   * already inside one pass holding one `config`, and this only rearranges what
   * it holds. Task 2d's re-founding rewrites a row's `id` and can use it the
   * same way.
   */
  const withTabRow = (tabs: TabRow[], tabId: string, next: TabRow | null): TabRow[] => {
    const at = tabs.findIndex((row) => row.id === tabId)
    if (at === -1) return next ? [...tabs, next] : tabs
    if (!next) return tabs.filter((_, index) => index !== at)
    return tabs.map((row, index) => (index === at ? next : row))
  }

  /** This tab's panes, in the order its row lays them out. */
  const held = (panes: PaneRecord[], kids: string[]): PaneRecord[] => {
    const byId = new Map(panes.map((pane) => [pane.id, pane]))
    // Filtered rather than mapped: both callers build `kids` from ids that are
    // in `panes` by construction, so nothing is dropped here today — but a
    // `map` would answer a future mismatch with an `undefined` in the array
    // that type-checks as a `PaneRecord` and reaches the renderer as one.
    return kids.flatMap((kid) => {
      const pane = byId.get(kid)
      return pane ? [pane] : []
    })
  }

  // Keyed to the three channels this file actually pushes unprompted, rather
  // than left as `(channel: string, payload: unknown)`: `unknown` is exactly
  // what let `CHANNELS.exit`'s payload go out missing `reason` for as long as
  // it did — `tsc` has no payload shape to check an omission against. A
  // per-channel map turns dropping a field back into a compile error.
  type SentPayloads = {
    [CHANNELS.data]: DataEvent
    [CHANNELS.exit]: ExitEvent
    [CHANNELS.statusChanged]: StatusEvent
  }

  const send = <C extends keyof SentPayloads>(channel: C, payload: SentPayloads[C]): void => {
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
  const sessionSurvived = async (record: PaneRecord, reason: ExitReason): Promise<boolean> => {
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
      send(CHANNELS.exit, { id: record.id, code, sessionAlive, reason })
      if (!sessionAlive) {
        // Stamped ahead of `forgetTab` below, and carrying `record` with it.
        // `forgetTab` deletes the saved config row, and by the time a
        // listener as far away as the notification router tries to
        // rediscover this tab from its id alone, both the live manager entry
        // (already gone — `manager.ts` deleted it before this callback even
        // ran) and the saved row can be gone too, resolving to nothing and
        // leaving `crashed`/`ended` the only two states that could never
        // toast. Passing `record` sidesteps that race outright rather than
        // betting on read/write ordering across two independent config-file
        // operations. `killed` is exempted for the same reason it always
        // was: the CHANNELS.kill handler below calls `registry.forget` once
        // its own await on the very same `manager.kill()` promise settles,
        // and recording a tombstone here too would race that forget with no
        // ordering guarantee — whichever runs last wins, and a losing
        // `forget` would leak a `crashed`/`ended` entry nothing would ever
        // clean up. A kill the user asked for does not need a tombstone —
        // they already know it is gone.
        if (reason !== 'killed') registry.applyExit(record.id, code, record)
        // `killed` is never pruned here either, for the same reason: the
        // CHANNELS.kill handler already owns that, and forgets the tab
        // immediately after the same `manager.kill()` this resolved against
        // has succeeded — pruning here too would only be a redundant second
        // write of the same outcome.
        if (reason === 'exited') await forgetTab(record.id)
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
    //
    // Per pane, not per tab row: status is tracked by tab id, which since v5
    // is a pane's own id (a group's founder id for a split tab, but every
    // pane still has one), and `result.tabs` holds layout — axis and ratios —
    // not the ids this loop needs.
    for (const pane of result.panes) {
      if (registry.get(pane.id) === null) registry.applyOpen(pane.id, pane.type)
    }

    // Whatever the hook script spooled while nothing was listening — a
    // socket write that failed because the app was down. Run only now,
    // after the reconcile above has decided which tabs actually survived:
    // an event for a tab tmux no longer has must not resurrect a dot for a
    // session that is gone. A second `restore` in one run (⌘R) costs
    // nothing extra — the spool file drainSpool already took is gone.
    //
    // Applied silently: replaying describes a past, and routing each one to
    // the notification router the way a live transition is would toast the
    // whole weekend back at the user in a tight loop the moment the app
    // opens. `refreshBadge` below still catches the badge up in one shot
    // once the final state is in, rather than leaving it stale until some
    // unrelated tab's next live transition happens to correct it.
    //
    // Per pane again: a spooled hook message names the pane's own
    // `PRCLI_TAB_ID`, never a tab row's group id.
    const live = new Set(result.panes.map((pane) => pane.id))
    const spooled = await drainSpool(hookPaths().spool, Date.now())
    for (const message of spooled) {
      if (!live.has(message.tabId)) continue
      // A spooled death is never replayed. A tab that died while the app was
      // down has no session left, so reconcile has already pruned its row and
      // the membership check above drops the line anyway — which makes this
      // branch unreachable in every case that can actually happen, and the
      // only cases it *could* reach are ones where replaying would be wrong:
      // an id reopened since would be painted red for a life that already
      // ended, and `applyDead`'s verdict would then outrank how the new one
      // really ends. Silence is the same answer in the reachable case and the
      // safe one in the rest.
      if (message.event === 'Exit') continue
      registry.applyHook(message, { silent: true })
    }
    refreshBadge()

    // Folded into the same response rather than left for the renderer's own,
    // separate `status()` call: that call raced this whole reconcile — which
    // takes seconds at twelve tabs — with no ordering guarantee, and the
    // renderer's `restored` case resets `status` to `{}`, so the direction
    // that loses blanks the board at every launch. One response has nothing
    // left to race against.
    return { ...result, status: registry.snapshot() }
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
   * The pane set is config's, not the manager's. A detached tab stays in the tab
   * bar — its session is running and only its client is gone — so describing
   * against live clients alone would drop the Unsorted row such a tab needs.
   * Every caller below runs inside the write queue, where config's pane list is a
   * superset of the manager's: an `open` records its pane through the same queue
   * before anything else can read it.
   *
   * Panes, because `describeProjects` resolves each project's `activeTabId`
   * against the rows it is given and has always been given pane rows — see the
   * ambiguity recorded on `ProjectRecord.activeTabId`.
   */
  const described = async (config: PrcliConfig): Promise<ProjectDescriptor[]> =>
    withUnsorted(await describeProjects(config.projects, config.panes), config.panes)

  ipcMain.on(CHANNELS.setActive, (_event, id: string | null) => {
    // Read directly, never through `serialise`: the queue has no reentrancy
    // protection, and this callback is what the router's `isAttended` reads
    // on every transition. Anything downstream of it calling back into
    // `serialise` would deadlock the queue silently.
    onActiveTabChanged(id)
    void serialise(async () => {
      if (id === null) return
      const config = await store.read()
      // A pane row: this writes the id back to `ProjectRecord.activeTabId`,
      // which `describeProjects` resolves against pane rows. v5 leaves that
      // pairing exactly as it was rather than moving one end of it — see the
      // ambiguity recorded on `ProjectRecord.activeTabId`.
      const tab = config.panes.find((saved) => saved.id === id)
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

      // Every pane of the tab, or none of them. A pane's project membership
      // lives in its own member session name, so moving the founder alone
      // would leave the tab split across two projects; `moveTabToProject`
      // renames every member and rolls the lot back if any rename is refused.
      //
      // The saved rows go along because a pane whose client has gone is
      // resolved through tmux, which synthesises a cwd and knows no command at
      // all; config holds the real ones. The map is keyed by pane id over the
      // whole of `config.panes` rather than over this tab's rows alone: the
      // callee looks up only the panes it actually moves, so the other entries
      // cost a lookup that never happens, and narrowing it by the tab's layout
      // row would drop the truth for a pane whose row is on disk but whose tab
      // row — layout only, and dropped by `read()` whenever it stops
      // describing panes that exist — is not.
      const known = new Map<string, Pick<PaneRecord, 'cwd' | 'command' | 'type'>>(
        config.panes.map((row) => [
          row.id,
          { cwd: row.cwd, command: row.command, type: row.type },
        ]),
      )
      const moved = await manager.moveTabToProject(tabId, target.slug, known)

      // Replace in place where config already lists a pane, so the tab bar
      // keeps its order; append the ones it does not list. A plain `map` would
      // quietly drop the record for a pane config had never written — the
      // invariant that restore always writes one first holds on every path
      // this milestone exercises, but it is an invariant, not a guarantee, and
      // the cost of it failing is a session running under a name nothing on
      // disk knows. This invents nothing: the renames above succeeded, so the
      // sessions are there.
      //
      // The tab's own row is deliberately untouched: it carries layout, and a
      // move changes no pane id, no axis and no ratio.
      const byId = new Map<string, PaneRecord>(moved.map((pane) => [pane.id, pane]))
      const listed = new Set(config.panes.map((row) => row.id))
      const panes = [
        ...config.panes.map((row) => byId.get(row.id) ?? row),
        ...moved.filter((pane) => !listed.has(pane.id)),
      ]
      const updated: PrcliConfig = { ...config, panes }
      await store.write(updated)
      return { projects: await described(updated), panes: moved }
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
      // The two things main holds for a pane only so a restart can use them,
      // dropped together — a killed pane is not restartable. See
      // `SessionManager.forgetPane`.
      manager.forgetPane(id)
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
      // `reopenInTab`, not `open`: a pane of a split has to REJOIN its tab's
      // group, and a bare `new-session -A` would bring it back beside the tab
      // instead of in it (finding I4). The manager decides which of the three
      // cases this is — see `reopenInTab`; only the "still has live siblings"
      // one does anything `open` did not.
      //
      // Nothing here says which tab the pane was in, and nothing in the
      // request could: the manager recorded that when the pane was created or
      // adopted. See `SessionManager.tabWasIn` and `RestartRequest`.
      const record = await manager.reopenInTab({
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
    // Dismissing the tombstone is what takes Restart off the screen, so the
    // tab id kept for it goes the same way its geometry does.
    manager.forgetPane(id)
  })

  ipcMain.handle(CHANNELS.splitPane, async (_event, request: SplitRequest): Promise<TabShape> => {
    const { paneId, dir, cols, rows } = request
    // Refused, not defaulted. `splitTab` falls back to 80×24 and then resizes
    // the new window to whatever it settled on, unconditionally — `open()`'s
    // "no size given means do not size the window" guard does not reach it — so
    // an unmeasured split drives a window to the default rather than leaving it
    // to follow its client. Same shape of test as `CHANNELS.resize`'s guard,
    // and written as `>=` rather than `<` so a `NaN` from a renderer that
    // measured a hidden element is refused too.
    if (!(cols >= 1 && rows >= 1)) {
      throw new Error(`Cannot split: pane ${paneId} was not measured (got ${cols}x${rows})`)
    }

    // Outside every `serialise` pass, like `CHANNELS.kill`'s `manager.kill`:
    // the tmux work first, then one pass of our own. Doing it the other way
    // round would be worse than slow — `serialise` is `tail.then(op, op)` with
    // no reentrancy protection, so anything it reaches that calls back into it
    // waits on its own caller for good.
    const record = await manager.splitTab({ paneId, cols, rows })

    // Read off the NEW pane, after the split, rather than derived a second time
    // from the sibling: this is the id `splitTab` itself decided and recorded
    // for the member it just made, so the row written below cannot be named
    // something the manager disagrees with.
    //
    // The sibling is asked second, and the sibling's own id only third. Nothing
    // can actually reach past the first — `tabIdOf` is the next synchronous
    // statement after the `await` above resolves, and the pty exit callback
    // that disposes an entry is a macrotask, which cannot interleave inside a
    // microtask continuation. But the last fallback is wrong wherever it is
    // reached: `paneId` is the SIBLING's id, and that equals the tab id only
    // when the sibling is the founder. Split from any other pane and it names a
    // tab nothing matches, which loses the layout at the next restore — the
    // failure `tabIdOf`'s own doc warns about. Asking the sibling's entry first
    // costs nothing and is right in both directions.
    const tabId = manager.tabIdOf(record.id) ?? manager.tabIdOf(paneId) ?? paneId

    // The same initialisation `CHANNELS.open` does, and needed for the same
    // reason: nothing else gives a pane its first state, so a `claude` pane
    // split off a tab would otherwise show no dot at all until its first hook.
    registry.applyOpen(record.id, record.type)

    return serialise(async () => {
      const config = await store.read()
      const panes = [...config.panes.filter((saved) => saved.id !== record.id), record]

      // `store.read()` has already dropped every kid that named a pane not in
      // `config.panes`, so the saved kids all still exist and none needs
      // filtering here. No saved row at all means a tab that has never been
      // split: `CHANNELS.open` writes none and restore writes one for every tab
      // it brings back, so the sibling alone is the best starting point.
      const saved = config.tabs.find((row) => row.id === tabId)
      const savedKids = saved?.layout.kids ?? [paneId]
      // Unioned with the tab's other live panes, because the row alone is not
      // the whole tab: a pane that died and was restarted is running, back in
      // this group, and back in `config.panes`, but no row claims it — its row
      // entry went when it died and nothing puts it back until the next
      // restore. Building `kids` from the row alone would drop a LIVE pane from
      // both the file and the reply, which is the one thing `TabShape` promises
      // not to do. Appending it is also exactly what `restore.ts`'s `tabRowFor`
      // does with a pane its saved row never knew, so this writes the row the
      // next restore would have produced rather than inventing a policy.
      //
      // `manager.panesOfTab` rather than the manager's own entries: it starts
      // from live tmux, so it also sees a pane whose session survives with no
      // client attached — detached, and still a member of this tab. Only the
      // ids are read, so the cwd it synthesises for a pane it has no entry for
      // never reaches anything.
      //
      // Filtered against `panes` because a kid has to name a pane row: an id
      // that names none would be dropped by the next `store.read()` anyway, and
      // `held` below would answer for it with nothing.
      const listed = new Set(panes.map((pane) => pane.id))
      const unclaimed = (await manager.panesOfTab(tabId))
        .map((pane) => pane.id)
        .filter((id) => id !== record.id && !savedKids.includes(id) && listed.has(id))
      const siblings = [...savedKids, ...unclaimed]
      const at = siblings.indexOf(paneId)
      const kids =
        at === -1
          ? [...siblings, record.id]
          : [...siblings.slice(0, at + 1), record.id, ...siblings.slice(at + 1)]

      const row: TabRow = {
        // The GROUP's id, never the new pane's — a pane added to a tab is not
        // its founder, and a row named after it would stop matching the tab at
        // the next restore, which resolves rows by the group's id.
        id: tabId,
        // The pane the user just asked for is the one they are looking at.
        activePaneId: record.id,
        layout: {
          // A tab's axis is set by the split that CREATES it, and a later
          // split adds a pane along that axis instead of re-orienting the tab.
          //
          // A RULING, not something the one-axis-per-tab rule forces — three
          // answers are consistent with that rule and this is the chosen one,
          // so it is written down rather than left to be re-derived. Applying
          // the request every time was the other behaviour this had: it makes
          // the axis always reflect the last split asked for, but the cost
          // lands on panes the user did not touch, and with terminals a
          // re-orientation is not cosmetic — every pane reflows and its real
          // tmux session is resized. Refusing the split outright was the third,
          // rejected as a dead key with no explanation. Ignoring is the only
          // one where nothing the user did not act on moves.
          //
          // Gated on the tab actually being split, not merely on a row
          // existing. Restore writes a row for every tab it brings back,
          // one-pane tabs included, so keying off `saved` alone would make
          // ⇧⌘D silently do ⌘D on any tab relaunched since it was opened — the
          // dead-key failure the ruling exists to avoid, reached from the other
          // side. A tab of one pane has no axis on screen to preserve.
          dir: saved && siblings.length > 1 ? saved.layout.dir : dir,
          // Even across the kids. A share carved out of the sibling's alone
          // would preserve the other panes' widths, but it would also let a
          // tab split repeatedly hand each new pane a sliver of a sliver;
          // ratios are the one thing the user can drag straight back.
          ratio: kids.map(() => 1 / kids.length),
          kids,
        },
      }

      // Both arrays in one write. `rememberTab` is deliberately not used: it is
      // itself a `serialise` wrapper and would deadlock inside this pass, and
      // it writes `config.panes` alone — a separate write for the tab row would
      // leave a window in which the file holds a pane no tab lists.
      const tabs = withTabRow(config.tabs, tabId, row)
      await store.write({ ...config, panes, tabs })
      return { panes: held(panes, kids), tabs: [row] }
    })
  })

  ipcMain.handle(CHANNELS.closePane, async (_event, paneId: string): Promise<TabShape> => {
    // Before the kill, and it has to be: `manager.kill()` deletes the entry
    // this is held on, and a dead pane's tab is not recoverable afterwards —
    // its membership lived in the tmux session the kill destroys. The fallback
    // is a pane this process never held, which is a tab of one by definition.
    const tabId = manager.tabIdOf(paneId) ?? paneId

    // Recorded before the first await inside `manager.kill()` can run, for the
    // reason `CHANNELS.kill` records it: the exit event this raises is settled
    // by asking this map, and it fires while the kill is still in flight. See
    // `pendingKills`.
    const outcome = manager.kill(paneId)
    pendingKills.set(paneId, outcome)
    try {
      await outcome
    } finally {
      pendingKills.delete(paneId)
    }
    // Everything `CHANNELS.kill` forgets, for its reasons: a killed pane is not
    // restartable, so its state, the geometry a restart would have attached at
    // and the tab a restart would have rejoined all go together.
    registry.forget(paneId)
    lastGeometry.delete(paneId)
    manager.forgetPane(paneId)

    return serialise(async () => {
      const config = await store.read()
      const panes = config.panes.filter((saved) => saved.id !== paneId)

      // The same union `splitPane` builds, and for the same reason: a pane that
      // died and was restarted is live and in `config.panes` but in no row, and
      // closing its sibling must not be the thing that drops it from the tab.
      // The pane just closed cannot come back through it — `manager.kill()`
      // destroyed its tmux session, which is what `panesOfTab` reads, and
      // `listed` is the survivors on disk.
      const saved = config.tabs.find((row) => row.id === tabId)
      const savedKids = saved?.layout.kids ?? []
      const listed = new Set(panes.map((pane) => pane.id))
      const unclaimed = (await manager.panesOfTab(tabId))
        .map((pane) => pane.id)
        .filter((id) => !savedKids.includes(id) && listed.has(id))
      const kids = [...savedKids.filter((kid) => kid !== paneId), ...unclaimed]

      // `restore.ts`'s `tabRowFor` algorithm, on the same inputs and for the
      // same reason: a kid the saved row knew keeps its own share, anything
      // else takes an even one, and the lot is rescaled so the row describes a
      // whole tab. Kids and shares are index-aligned and `store.read()` has
      // already made the shares one per kid, positive and finite, so the saved
      // ones can be read straight off. Without the rescale they sum to less
      // than 1 on disk — invisible through `store.read()`, which rescales them
      // again on the way back in.
      //
      // A tab with no panes left loses its row outright rather than keeping an
      // empty one, which would put a tab nobody can see in the bar until the
      // next read swept it.
      let row: TabRow | null = null
      if (kids.length > 0) {
        const even = 1 / kids.length
        const shares = kids.map((kid) => {
          const at = savedKids.indexOf(kid)
          return at === -1 || !saved ? even : saved.layout.ratio[at]
        })
        const total = shares.reduce((sum, share) => sum + share, 0)
        const active = saved?.activePaneId
        row = {
          id: tabId,
          // Selection has to name a pane the tab still holds; when the closed
          // pane was the selected one the first survivor takes it.
          activePaneId: active && kids.includes(active) ? active : kids[0],
          layout: { dir: saved?.layout.dir ?? 'row', ratio: shares.map((s) => s / total), kids },
        }
      }

      const tabs = withTabRow(config.tabs, tabId, row)
      await store.write({ ...config, panes, tabs })
      return { panes: row ? held(panes, row.layout.kids) : [], tabs: row ? [row] : [] }
    })
  })

  ipcMain.handle(CHANNELS.notifications, async () => (await store.read()).notifications)

  ipcMain.handle(
    CHANNELS.updateNotifications,
    (_event, patch: Partial<NotificationConfig>): Promise<NotificationConfig> =>
      serialise(async () => {
        const config = await store.read()
        const notifications = { ...config.notifications, ...patch }
        await store.write({ ...config, notifications })
        return notifications
      }),
  )

  // installHooks/uninstallHooks write ~/.claude/settings.json, not PRCLI's own
  // config file, so these deliberately do not go through `serialise` above.
  // That queue has no reentrancy protection, and nothing reached from inside
  // it may call back into it — going through it here would risk a silent
  // deadlock for a screen the user is looking straight at.
  ipcMain.handle(CHANNELS.hooksState, () => readHooksState())
  ipcMain.handle(CHANNELS.installHooks, () => installHooks())
  ipcMain.handle(CHANNELS.uninstallHooks, () => uninstallHooks())
}
