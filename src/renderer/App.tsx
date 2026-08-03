import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Terminal, paneGrid } from './Terminal'
import { PaneDivider } from './PaneDivider'
import { TabBar } from './TabBar'
import { DeadPane } from './DeadPane'
import { Sidebar } from './Sidebar'
import { RightPanel } from './RightPanel'
import { AddProjectDialog } from './AddProjectDialog'
import { SettingsPane } from './SettingsPane'
import { Welcome } from './Welcome'
import { cn } from './lib/cn'
import {
  INITIAL_WORKSPACE_STATE,
  activeProject,
  activeTabId,
  canOpenSession,
  grabFor,
  needsYou,
  paneGroups,
  paneInDirection,
  panesOfTab,
  projectIdForTab,
  resizeKids,
  stateOfProject,
  tabOfPane,
  tabsOfProject,
  welcomeHint,
  workspaceReducer,
  type PaneBox,
  type PaneDirection,
} from './workspace'
import { projectMuted, toggleProjectMute } from './mute'
import { UNSORTED_ID, type NotificationConfig, type TabDescriptor, type TabType } from '../shared/ipc'

/**
 * The smallest a pane may be dragged to, in cells.
 *
 * 20 columns because below it almost anything wraps and a `claude` pane stops
 * being readable; 5 rows because a shell needs a prompt and a little scrollback
 * to be worth keeping. Cells rather than a percentage: what makes a terminal
 * unusable is column count, not its share of the window.
 *
 * This governs the DRAG only. A window resize squeezes panes proportionally,
 * through this floor if it comes to that — refusing that would mean fighting
 * the user's own window manager, and `Terminal.tsx`'s zero-size guard is what
 * protects the session there.
 */
const MIN_PANE_COLS = 20
const MIN_PANE_ROWS = 5

export function App() {
  const [state, dispatch] = useReducer(workspaceReducer, INITIAL_WORKSPACE_STATE)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  // Set once the workspace exists. Until then this window knows nothing about
  // what is selected and must not say anything about it — see the effects.
  const [ready, setReady] = useState(false)
  // Fetched once alongside status, and kept current from whatever
  // `updateNotifications` hands back. Null until the initial fetch resolves,
  // which the mute toggle treats as "nothing to toggle yet" rather than
  // guessing at a shape it has not seen.
  const [notifications, setNotifications] = useState<NotificationConfig | null>(null)

  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason))
  }, [])

  const project = activeProject(state)
  const currentTabId = activeTabId(state)
  const currentTabs = state.activeProjectId ? tabsOfProject(state, state.activeProjectId) : []
  // Hoisted out of the JSX below because the welcome page's condition is read
  // off it. "No visible group" is the literal statement of an empty pane area,
  // and it is not the same as "no tabs": a tab whose kids were all boxed by an
  // earlier row emits no group at all (`workspace.ts:667`).
  const groups = paneGroups(state)
  const showWelcome = !groups.some((group) => group.visible)
  // Whether a project is active, is not Unsorted, and its cwd is on disk:
  // see `canOpenSession` in workspace.ts, which `welcomeHint` also reads so
  // the two cannot silently disagree.
  const canOpen = canOpenSession(state)

  // `type` is a declaration of intent recorded on the tab, not inferred from
  // `command` — it decides the launch state a fresh dot starts in
  // (`stateForOpen` in src/main/status/machine.ts) and, for `claude`, gives a
  // broken hook install a hollow dot to show instead of nothing. It must be
  // named by the caller: `RightPanel`'s dedicated `claude` button passes
  // `'claude'`, a repository or user preset passes `'preset'`, and a bare
  // ⌘T/+ shell defaults to `'shell'`.
  const launch = useCallback(
    (command: string | undefined, type: TabType = 'shell') => {
      if (!project || !canOpen) return
      window.prcli
        .open({ projectSlug: project.slug, cwd: project.cwd, command, type })
        .then((tab) => dispatch({ type: 'opened', tab }))
        .catch(fail)
    },
    [project, canOpen, fail],
  )

  const openTab = useCallback(() => launch(undefined), [launch])

  // The selection is a PANE id — the tab bar lists panes — so this is the
  // pane ⌘D splits, ⌘W closes and ⌘⌥arrow moves off. Every route that changes
  // which pane is active writes it, so the tab bar's highlight, the focused
  // xterm and what `setActive` tells main are one fact and cannot drift apart.
  const activePaneId = currentTabId

  /**
   * Close one pane, and the tab with it when it was the last one.
   *
   * The only close there is. It kills the pane's session and drops everything
   * main held for it — its status, the geometry a restart would have used, its
   * config row — and maintains the tab's layout row while doing it. The
   * narrower `kill` channel did all of that except the row; two ways to close
   * a pane, differing only in whether the layout survived, was a place for
   * what is on screen to drift from what is on disk.
   *
   * Only ever a LIVE pane, which is why nothing here clears the pane's `dead`
   * tombstone. `TabBar` gives a dead tab's × to Dismiss rather than to Close:
   * the same glyph, beside a ↻, wired somewhere else. And ⌘W on a dead pane
   * rejects inside `manager.kill` — no entry to kill, and no orphan to find
   * either, since the session is gone — so it surfaces through `fail` and no
   * `closedPane` is dispatched for it at all. That is unchanged from `kill`,
   * which rejected identically; it is written down because this is now the
   * only close there is, and the next person will ask where that error came
   * from.
   */
  const closePane = useCallback(
    (paneId: string) => {
      window.prcli
        .closePane(paneId)
        .then((shape) => dispatch({ type: 'closedPane', paneId, shape }))
        .catch(fail)
    },
    [fail],
  )

  /**
   * Add a pane beside the active one, along `dir`.
   *
   * `dir` is honoured only by the split that turns a single pane into a split
   * tab; after that the tab keeps its axis and the new pane joins it. See
   * `SplitRequest.dir` — and the note in the Pane menu, which is where a user
   * finds out.
   */
  const splitActive = useCallback(
    (dir: 'row' | 'col') => {
      if (!activePaneId) return
      const grid = paneGrid(activePaneId)
      // No terminal mounted for the selection, so there is no pane on screen
      // to split off. Sending an unmeasured size instead is what `SplitRequest`
      // exists to refuse.
      if (!grid) return
      // Half the pane being split, along the axis being split — exact for the
      // first split of a tab and an approximation after that, since the other
      // panes give up a share too. What it must not be is unmeasured:
      // `splitTab` sizes the new window to whatever it is handed, and 80x24 is
      // the geometry defect this codebase has shipped twice, which is why
      // `SplitRequest` demands these. The approximation costs nothing — the
      // new pane's Terminal fits itself to its own box the moment it mounts
      // and sends the size it really got.
      const half = (cells: number): number => Math.max(1, Math.floor(cells / 2))
      // A tab keeps the axis of the split that created it, and main applies that
      // ruling by counting the kids on its own row. Its count and the user's
      // disagree over a tombstone: main forgot that pane at its death, so a tab
      // drawn as two boxes — one live, one dead — reads as one pane there and
      // ⇧⌘D would silently re-orient a tab the user is looking at as split.
      // Asking here instead, where the boxes actually are, and sending the axis
      // already on screen. Still only ever honoured by a split that CREATES a
      // split tab; see `SplitRequest.dir`.
      //
      // Two computations of one rule, but NOT two authorities — which is the
      // thing that made `tabIdOf` and `tabIdFromGroupName` dangerous, and the
      // reason to say why it does not apply here. Main can only ever OVERRIDE
      // what is sent, with `saved.layout.dir`, and only when its own row has
      // more than one kid; so the value below decides the axis exactly when
      // main declines to. When main does not decline, the two agree by
      // provenance rather than by luck: `row` came from main's own reply (or
      // from `tabRowFor`), and `withKeptPanes` spreads `...next.layout`, so
      // `row.layout.dir` IS main's `dir` travelled back.
      const row = tabOfPane(state, activePaneId)
      const drawn = row ? panesOfTab(state, row.id) : []
      const axis = row && drawn.length > 1 ? row.layout.dir : dir
      // Refused here rather than in main, because this is where the only
      // cell-accurate numbers are: main has no idea what a column is. Checked
      // against `axis`, not the requested `dir` — a split on a tab already
      // split with more than one pane is added along the tab's OWN axis
      // regardless of which shortcut asked for it (the ruling just above), so
      // `dir` alone can name the wrong dimension: a tab split `row` and then
      // asked for ⇧⌘D (`dir` = `col`) still carves along `row`, and a check
      // against `dir` would test `grid.rows` against `MIN_PANE_ROWS` while the
      // carve that actually happens tests `grid.cols` against
      // `MIN_PANE_COLS` — the wrong pair, in both directions: a genuinely
      // too-narrow carve could pass unrefused, and a genuinely fine one could
      // be refused for a floor that was never in play. A split that cannot
      // give the new pane its floor would produce a pane too small to use,
      // which is 2b's "sliver of a sliver" answered before it happens rather
      // than tolerated after.
      const wouldBe = axis === 'row' ? half(grid.cols) : half(grid.rows)
      const floor = axis === 'row' ? MIN_PANE_COLS : MIN_PANE_ROWS
      if (wouldBe < floor) {
        setError(`Not enough room to split: a pane needs at least ${floor} ${axis === 'row' ? 'columns' : 'rows'}`)
        return
      }
      window.prcli
        .splitPane({
          paneId: activePaneId,
          dir: axis,
          cols: axis === 'row' ? half(grid.cols) : grid.cols,
          rows: axis === 'col' ? half(grid.rows) : grid.rows,
        })
        .then((shape) => {
          dispatch({ type: 'split', shape })
          // Main names the pane it just made, in the row it hands back. The
          // pane the user asked for is the one they should be typing into.
          const active = shape.tabs[0]?.activePaneId
          if (active) dispatch({ type: 'activatedTab', id: active })
        })
        .catch(fail)
    },
    [state, activePaneId, fail],
  )

  /** Make `paneId` the pane the keyboard talks to, and record it on its tab. */
  const selectPane = useCallback(
    (paneId: string) => {
      if (paneId === activePaneId) return
      const row = tabOfPane(state, paneId)
      if (row) dispatch({ type: 'activatedPane', tabId: row.id, paneId })
      dispatch({ type: 'activatedTab', id: paneId })
    },
    [state, activePaneId],
  )

  /**
   * Move the selection one pane along its tab's axis.
   *
   * A movement that would fall off either end does nothing, and so does one
   * across the tab's axis — see `paneInDirection`, which answers both with
   * undefined.
   */
  const focusPane = useCallback(
    (direction: PaneDirection) => {
      if (!activePaneId) return
      const target = paneInDirection(state, activePaneId, direction)
      if (!target) return
      selectPane(target.id)
    },
    [state, activePaneId, selectPane],
  )

  /**
   * The one drag in progress, as it stood the moment it was grabbed.
   *
   * A ref, and not state, for the reason `PaneDivider` keeps its own gesture
   * facts in one: none of this is rendered, and putting it in state would
   * re-render every tab on every frame to no visible effect.
   *
   * Everything a frame needs is captured here at pointerdown, so a move handler
   * is a clamp and a dispatch and nothing else. That is not tidiness — it is
   * what makes a clamped drag behave. `PaneDivider` reports the CUMULATIVE
   * travel since the press, and applying a cumulative number to a ratio the
   * previous frame already moved re-adds the whole travel every frame
   * (0.50 → 0.51 → 0.53 → 0.56 for three even steps of 0.01: quadratic in frame
   * count, and pinned to the floor within a few of them). Against the ratio as
   * it was grabbed, the same number means what it says, and the floor behaves
   * the way a hand expects: push into it, keep pushing, reverse, and the
   * divider stays pinned until the cursor comes back past the point where the
   * floor bit. Sending an incremental delta instead would move the divider the
   * instant the cursor turned round, while the cursor was still deep in
   * forbidden territory, and the two would never line up again.
   *
   * Not cleared on release. A gesture is established whole at every pointerdown
   * and `PaneDivider` reports no movement without one, so a leftover here is
   * inert — and clearing it would be one more thing Task 5's `commitLayout` has
   * to remember to keep doing.
   */
  const grabbed = useRef<{ tabId: string; at: number; ratio: number[]; min: number } | null>(null)

  /**
   * Take hold of the divider before box `index` of `tabId`, or refuse to.
   *
   * The pair resolution, the three refusal guards and the floor derivation all
   * live in `grabFor` (`workspace.ts`) now — see its doc comment for why any of
   * that is needed. This is only the lookup of `tabId`'s row and the write into
   * `grabbed`.
   */
  const grabPane = useCallback(
    (tabId: string, index: number, boxes: PaneBox[]) => {
      const row = state.tabs.find((candidate) => candidate.id === tabId)
      const held = row
        ? grabFor(row, boxes, index, paneGrid, { cols: MIN_PANE_COLS, rows: MIN_PANE_ROWS })
        : null
      grabbed.current = held ? { tabId, ...held } : null
    },
    [state.tabs],
  )

  /**
   * One frame of the drag `grabPane` set up: clamp the travel and say so.
   *
   * Nothing is read from the current state, which is what makes this stable
   * across renders and free of the compounding described above. The reducer has
   * the last word on whether the ratio still fits the row — a gesture that
   * raced a split carries the wrong number of kids, and `resized` drops it.
   *
   * There is no push to tmux here and there must not be one: the panes reflow
   * from `state.tabs`, `Terminal`'s ResizeObserver sees its box change, and the
   * fit that follows resizes the real session. One path, already tested.
   */
  const dragPane = useCallback((delta: number) => {
    const held = grabbed.current
    if (!held) return
    dispatch({
      type: 'resized',
      tabId: held.tabId,
      ratio: resizeKids(held.ratio, held.at, delta, held.min, held.min),
    })
  }, [])

  /**
   * The end of a drag: write the tab's ratios to disk, once. This is why it is
   * called with the tab and not with nothing, and why the drag itself writes
   * nothing — a persist per frame would be a file write per pointer move.
   *
   * It runs after every release of a divider, including one whose `grabPane`
   * refused and which therefore moved nothing: the divider reports a release it
   * saw, and it has no way to know the caller declined the grab. That is fine
   * here — a tab with no row in `state.tabs` sends nothing, and one that has a
   * row sends the ratios that are there, which in that case are the ones
   * already on disk.
   */
  const commitLayout = useCallback(
    (tabId: string) => {
      const row = state.tabs.find((candidate) => candidate.id === tabId)
      if (!row) return
      // Named, not positional: main's row is a subset of this one whenever the
      // tab holds a tombstone, and pairing the two by index is what dropped
      // every such drag. Whole-tab fractions, tombstones included — which is
      // what this row holds, on every path that writes it.
      window.prcli.setLayout(
        tabId,
        Object.fromEntries(row.layout.kids.map((id, index) => [id, row.layout.ratio[index] ?? 0])),
      )
    },
    [state.tabs],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // `status` comes back inside the same response as `projects`/`panes`
      // rather than from its own, separate `status()` call: that call used
      // to race `restore()`'s own multi-second reconcile (detach-all,
      // `findOrphans`, one `tmux new-session -A` per tab) with no ordering
      // guarantee between the two IPC round trips, and `restored` resets
      // `status` to `{}` — so the direction that lost blanked the board at
      // every launch with real sessions running. One response has nothing
      // left to race against.
      const [{ projects, panes, tabs, activeProjectId, status }, notificationConfig] =
        await Promise.all([window.prcli.restore(), window.prcli.notifications()])
      if (cancelled) return
      dispatch({ type: 'restored', projects, panes, tabs, activeProjectId, status })
      setNotifications(notificationConfig)
      setReady(true)
    })().catch((reason: unknown) => {
      // `ready` stays false: with no workspace there is nothing to report,
      // and saying so would overwrite what is on disk.
      if (!cancelled) fail(reason)
    })
    return () => {
      cancelled = true
    }
  }, [fail])

  // Every later state comes through here — the initial fetch above only
  // covers what had already happened before the renderer mounted.
  useEffect(
    () =>
      window.prcli.onStatus(({ tabId, state: tabState }) =>
        dispatch({ type: 'statusChanged', tabId, state: tabState }),
      ),
    [],
  )

  // The one place that tells the main process what is selected, so every path
  // is covered — including the ones nothing calls directly, like a close or a
  // death moving the active tab to a neighbour.
  useEffect(() => {
    if (!ready) return
    window.prcli.setActive(currentTabId)
  }, [ready, currentTabId])

  useEffect(() => {
    if (!ready) return
    window.prcli.setActiveProject(state.activeProjectId)
  }, [ready, state.activeProjectId])

  // A client stopping is not a session dying. `Ctrl-b d` inside a pane, and
  // the detach restore does before it reattaches, both arrive here with the
  // session still running, and those tabs must stay. What changes when the
  // session really has died is what happens next — the tab stays, marked
  // dead, instead of vanishing.
  useEffect(
    () =>
      window.prcli.onExit(({ id, code, sessionAlive, reason }) => {
        if (sessionAlive) return
        // A kill the user asked for is not a death to render: main already
        // exempts `killed` from the registry tombstone for exactly this
        // reason (see register.ts's exit handler and the comment on
        // `ExitEvent.reason`). Without the same exemption here, every ⌘W
        // flashed as a dead tab, strikethrough and all, and a fast click on
        // the ↻ that briefly appeared in that window recreated the tmux
        // session the user had just killed — right after `removed` (below)
        // was about to drop the tab from the renderer entirely, leaving a
        // live session with no tab pointing at it.
        if (reason === 'killed') return
        dispatch({ type: 'died', id, code })
      }),
    [],
  )

  // A clicked toast asking for a tab that may belong to a project other than
  // the one on screen. Depends on `state.panes`/`state.projects` rather than
  // `[]` so the closure always has the current lookup tables instead of the
  // ones from first mount — the resubscribe this costs is a synchronous
  // `removeListener`/`on` pair on every workspace change, cheap next to a
  // stale closure silently failing to find a tab that has since moved.
  useEffect(
    () =>
      window.prcli.onFocusTab((tabId) => {
        const tab = state.panes.find((candidate) => candidate.id === tabId)
        if (!tab) return
        dispatch({ type: 'activatedProject', id: projectIdForTab(state.projects, tab) })
        dispatch({ type: 'activatedTab', id: tabId })
      }),
    [state.panes, state.projects],
  )

  const restartTab = useCallback(
    (tab: TabDescriptor) => {
      // No explicit cols/rows: the tab's Terminal is still mounted, so
      // `register.ts`'s `lastGeometry` — the size its last resize reported —
      // is what main attaches at, and the fit that follows the reattach
      // corrects anything stale. The renderer has nothing fresher to offer.
      //
      // The pane's record is the whole request, and there is nothing else to
      // send: which tab holds the pane is main's own record, not this one's to
      // supply, so offering Restart on a pane inside a split needs no change
      // here. See `RestartRequest`.
      window.prcli
        .restartTab({ tab })
        .then((restarted) => dispatch({ type: 'opened', tab: restarted }))
        .catch(fail)
    },
    [fail],
  )

  const dismissTab = useCallback((id: string) => {
    window.prcli.dismissTab(id)
    dispatch({ type: 'dismissed', id })
  }, [])

  const muted = useCallback(
    (projectId: string) => (notifications ? projectMuted(notifications.rules, projectId) : false),
    [notifications],
  )

  const toggleMute = useCallback(
    (projectId: string) => {
      if (!notifications) return
      const rules = toggleProjectMute(notifications.rules, projectId)
      window.prcli.updateNotifications({ rules }).then(setNotifications).catch(fail)
    },
    [notifications, fail],
  )

  // A menu item the user clicked rather than reached by its accelerator. The
  // keystrokes deliberately never reach the menu (`registerAccelerator: false`
  // in main), which is why these actions live here and main can only ask for
  // them — and why clicking one used to do nothing at all.
  useEffect(
    () =>
      window.prcli.onMenuCommand((command) => {
        switch (command) {
          case 'newTab':
            openTab()
            return
          case 'closePane':
            // Same guard the ⌘W handler applies: with no pane there is nothing
            // to close, and closePane(null) is not a thing to ask for.
            if (activePaneId) closePane(activePaneId)
            return
          case 'splitRight':
            splitActive('row')
            return
          case 'splitDown':
            splitActive('col')
            return
          case 'focusLeft':
            focusPane('left')
            return
          case 'focusRight':
            focusPane('right')
            return
          case 'focusUp':
            focusPane('up')
            return
          case 'focusDown':
            focusPane('down')
            return
          case 'togglePresets':
            setPanelOpen((open) => !open)
            return
          case 'settings':
            setSettingsOpen(true)
        }
      }),
    [activePaneId, openTab, closePane, splitActive, focusPane],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey) return

      // A ⌘ shortcut typed into one of the app's own text fields belongs to
      // that field. Without this, ⌘W during a project rename closed a tab and
      // destroyed its session, throwing the half-typed rename away with it.
      //
      // The opt-out is an explicit attribute rather than a blanket
      // "is this an input?" check, because xterm's focus target is a
      // `<textarea>`: a general guard would silently disable ⌘T and ⌘W
      // whenever a terminal had focus, which is the case this whole app is
      // about.
      if (event.target instanceof Element && event.target.closest('[data-shortcuts="off"]')) {
        return
      }

      // `event.code`, not `event.key`: on macOS ⌥ rewrites `key`, so ⌥⌘1
      // arrives as "¡" and a key-based check would never fire.
      if (event.code === 'KeyT' && !event.altKey) {
        event.preventDefault()
        openTab()
        return
      }
      if (event.code === 'KeyW' && !event.altKey && activePaneId) {
        event.preventDefault()
        closePane(activePaneId)
        return
      }
      // Both here rather than as registered menu accelerators, for the reason
      // the whole File menu is unregistered: an accelerator the menu claims
      // never reaches the window, and these keystrokes are typed at panes
      // running Claude. ⇧ picks the axis, so `KeyD` covers both.
      if (event.code === 'KeyD' && !event.altKey) {
        event.preventDefault()
        splitActive(event.shiftKey ? 'col' : 'row')
        return
      }
      // ⌘⌥ + an arrow, on `event.code` like every other binding here. ⌥ is
      // held, which is what rewrites `key` for the letter bindings above; one
      // rule for the whole handler is one rule to get right.
      if (event.altKey && !event.shiftKey) {
        const along: Record<string, PaneDirection> = {
          ArrowLeft: 'left',
          ArrowRight: 'right',
          ArrowUp: 'up',
          ArrowDown: 'down',
        }
        const direction = along[event.code]
        if (direction) {
          event.preventDefault()
          focusPane(direction)
          return
        }
      }
      if (event.code === 'Backslash' && event.shiftKey) {
        event.preventDefault()
        setPanelOpen((open) => !open)
        return
      }
      if (event.code === 'Comma') {
        event.preventDefault()
        setSettingsOpen(true)
        return
      }

      const digit = /^Digit([1-9])$/.exec(event.code)
      if (!digit) return
      const index = Number(digit[1]) - 1
      if (event.altKey) {
        const target = currentTabs[index]
        if (target) {
          event.preventDefault()
          dispatch({ type: 'activatedTab', id: target.id })
        }
        return
      }
      const target = state.projects[index]
      if (target) {
        event.preventDefault()
        dispatch({ type: 'activatedProject', id: target.id })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activePaneId, currentTabs, state.projects, openTab, closePane, splitActive, focusPane])

  return (
    <div className="flex h-screen w-screen bg-bg">
      <Sidebar
        projects={state.projects}
        activeProjectId={state.activeProjectId}
        tabsOf={(id) => tabsOfProject(state, id)}
        activeTabId={currentTabId}
        status={state.status}
        projectStateOf={(id) => stateOfProject(state, id)}
        needsYou={needsYou(state)}
        onSelectNeedy={(tab) => {
          dispatch({ type: 'activatedProject', id: projectIdForTab(state.projects, tab) })
          dispatch({ type: 'activatedTab', id: tab.id })
        }}
        muted={muted}
        onToggleMute={toggleMute}
        onSelectProject={(id) => dispatch({ type: 'activatedProject', id })}
        onSelectTab={(id) => dispatch({ type: 'activatedTab', id })}
        onAdd={() => setAdding(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onMoveTab={(tabId, projectId) => {
          // Renames each pane's tmux session. A pane id is the other half of
          // the name it keeps, so every pane keeps its scrollback and
          // everything running in it. The reply lists every pane that moved —
          // one, until 2b lets a tab hold more.
          window.prcli
            .moveTabToProject(tabId, projectId)
            .then(({ projects, panes }) => dispatch({ type: 'movedTab', panes, projects }))
            .catch(fail)
        }}
        onRename={(id, name) => {
          window.prcli
            .updateProject(id, { name })
            .then((projects) => dispatch({ type: 'projects', projects }))
            .catch(fail)
        }}
        onMove={(id, direction) => {
          const order = state.projects.filter((p) => p.id !== UNSORTED_ID).map((p) => p.id)
          const from = order.indexOf(id)
          const to = from + direction
          if (from === -1 || to < 0 || to >= order.length) return
          order.splice(to, 0, ...order.splice(from, 1))
          window.prcli
            .reorderProjects(order)
            .then((projects) => dispatch({ type: 'projects', projects }))
            .catch(fail)
        }}
        onRemove={(id) => {
          // The sessions keep running; they reappear under Unsorted, so a
          // relaunch is not needed to reach them again.
          window.prcli
            .removeProject(id)
            .then((projects) => dispatch({ type: 'projects', projects }))
            .catch(fail)
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar
          tabs={currentTabs}
          activeId={currentTabId}
          status={state.status}
          dead={state.dead}
          onActivate={(id) => dispatch({ type: 'activatedTab', id })}
          onClose={closePane}
          onRestart={restartTab}
          onDismiss={dismissTab}
          onNew={openTab}
          canOpen={canOpen}
        />
        {error ? (
          <pre
            data-testid="startup-error"
            className="m-0 whitespace-pre-wrap p-2 font-mono text-[13px] text-danger"
          >
            {error}
          </pre>
        ) : null}
        <div className="relative min-h-0 flex-1">
          {showWelcome ? <Welcome hint={welcomeHint(state)} /> : null}
          {/* Every terminal stays mounted, across every project and every tab:
              both maps below are unconditional, and neither list is filtered
              down to what is on screen. Unmounting would dispose an xterm and
              lose its scrollback on each switch. `paneGroups` decides the
              arrangement; see its tests for the arithmetic. */}
          {groups.map((group) => (
            <div
              key={group.id}
              data-testid={group.visible ? 'terminal-active' : `terminal-${group.id}`}
              className={cn(
                // `visibility`, not `display`: a hidden tab must stay laid
                // out so it can measure itself, or it attaches at 80×24 and
                // tmux shrinks the real session to match.
                // The hairline `gap` between panes is the only thing the axis
                // spends on itself. It overflows the bases, which sum to the
                // whole container, by one pixel; flex shrinking is weighted by
                // base size, so that pixel comes off the panes in the same
                // proportion as the ratios and leaves them intact.
                'absolute inset-0 flex gap-px p-2',
                group.visible ? 'visible z-10' : 'invisible z-0 pointer-events-none',
              )}
              style={group.style}
            >
              {group.panes.map((box) => (
                <div
                  key={box.pane.id}
                  data-testid={`pane-${box.pane.id}`}
                  data-active={box.pane.id === activePaneId ? 'true' : 'false'}
                  // Clicking a pane makes it the one the keyboard talks to.
                  // `onMouseDown` rather than `onClick` so the app has recorded
                  // it before the click moves DOM focus into that pane's
                  // textarea — and so a drag that starts a selection inside a
                  // pane counts as choosing it too.
                  onMouseDown={() => selectPane(box.pane.id)}
                  className={cn(
                    // `relative`: the dead-pane chrome below positions itself
                    // against this box, and an overlay that escaped to the
                    // group container would land on whichever pane happened to
                    // be at that corner.
                    'relative',
                    // `min-w-0 min-h-0`: a flex item's automatic minimum size
                    // is its content's, not zero, so an xterm canvas still
                    // sized for the whole tab could hold this box open past its
                    // share — and the fit that would resize that canvas
                    // measures this box, so it would have nothing to correct
                    // itself to.
                    'min-h-0 min-w-0',
                    // Which pane is listening, said out loud — but only where
                    // there is a choice to make. An inset ring rather than a
                    // border: it takes no space, so marking a pane cannot
                    // resize it and set off a fit of the real tmux session.
                    group.panes.length > 1 &&
                      box.pane.id === activePaneId &&
                      'shadow-[inset_0_0_0_1px_var(--color-accent)]',
                  )}
                  style={box.style}
                >
                  <Terminal
                    tabId={box.pane.id}
                    visible={group.visible}
                    // Never for a tab that is off screen: taking focus into one
                    // would move typing to a terminal the user cannot see.
                    focused={group.visible && box.pane.id === activePaneId}
                  />
                  {/* Only the pane's session has died — the box, the xterm and
                      the scrollback in it are all still here, which is why this
                      draws over the pane instead of collapsing it. See
                      `paneGroups`, which says why that is the opposite of what
                      restore does with a pane whose session is gone.

                      Gated on `box.dead` rather than on `state.dead[...]` read
                      again here: `paneGroups` decides it, once, down both of
                      its branches, and that is where it is tested. */}
                  {box.dead ? (
                    <DeadPane
                      pane={box.pane}
                      state={state.status[box.pane.id] ?? null}
                      onRestart={restartTab}
                      onDismiss={dismissTab}
                    />
                  ) : null}
                </div>
              ))}
              {/* The dividers, in an overlay of their own rather than among the
                  panes, and `inset-2` is the container's `p-2` written a second
                  time on purpose. An absolutely positioned element resolves its
                  percentages — and reports its parent's `offsetWidth` — against
                  its containing block's PADDING box, while the panes lay out in
                  the CONTENT box. As direct children of the padded container the
                  strips missed the real seam by up to the padding and measured a
                  drag axis two paddings too long, so every drag ran slow and
                  crept away from the cursor. This overlay IS the content box, so
                  both resolve against the right one. The duplication is real and
                  is the price; `dividers.test.ts` pins the two numbers together
                  so they cannot drift apart quietly.

                  `pointer-events-none` so the overlay is invisible to the mouse
                  everywhere the strips are not — each strip opts back in — and
                  no `key` juggling: a divider is keyed by the pane it precedes,
                  in a list of its own, so nothing here can disturb a pane box's
                  key or unmount a terminal.

                  That opting back in reaches further than this overlay, and it
                  is worth knowing which guard it leans on. A hidden tab carries
                  `pointer-events-none` on the container above, and a descendant
                  that sets `pointer-events: auto` is not covered by it — so what
                  actually keeps an off-screen divider from being grabbed is the
                  `invisible` beside it: `visibility: hidden` is not hit-tested,
                  and nothing in here sets `visibility: visible` to undo it. That
                  class is therefore load-bearing for input as well as for what is
                  drawn, and is not to be traded for something weaker. None of it
                  is new with the dividers — `DeadPane`'s ↻ and × are
                  `pointer-events-auto` inside the same hidden container and have
                  always rested on the same thing — which is why this is written
                  down here rather than fixed by drawing the overlay only for the
                  visible group. */}
              <div
                data-testid={`dividers-${group.id}`}
                className="pointer-events-none absolute inset-2 z-20"
              >
                {group.panes.map((box, index) =>
                  index > 0 ? (
                    <PaneDivider
                      key={box.pane.id}
                      dir={group.style.flexDirection === 'column' ? 'col' : 'row'}
                      offset={group.panes
                        .slice(0, index)
                        .reduce((sum, earlier) => sum + earlier.share, 0)}
                      onGrab={() => grabPane(group.id, index, group.panes)}
                      onDrag={dragPane}
                      onCommit={() => commitLayout(group.id)}
                    />
                  ) : null,
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {panelOpen ? (
        <RightPanel project={project} onRun={(command, type) => launch(command, type)} />
      ) : null}

      <AddProjectDialog
        open={adding}
        onOpenChange={setAdding}
        onAdd={(input) => {
          window.prcli
            .addProject(input)
            .then((projects) => {
              dispatch({ type: 'projects', projects })
              const added = projects.find((candidate) => candidate.cwd === input.cwd)
              if (added) dispatch({ type: 'activatedProject', id: added.id })
            })
            .catch(fail)
        }}
      />

      <SettingsPane
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        notifications={notifications}
        onNotificationsChange={setNotifications}
      />
    </div>
  )
}

