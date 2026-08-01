import { useCallback, useEffect, useReducer, useState } from 'react'
import { Terminal, paneGrid } from './Terminal'
import { TabBar } from './TabBar'
import { Sidebar } from './Sidebar'
import { RightPanel } from './RightPanel'
import { AddProjectDialog } from './AddProjectDialog'
import { SettingsPane } from './SettingsPane'
import { cn } from './lib/cn'
import {
  INITIAL_WORKSPACE_STATE,
  activeProject,
  activeTabId,
  needsYou,
  paneGroups,
  paneInDirection,
  projectIdForTab,
  stateOfProject,
  tabOfPane,
  tabsOfProject,
  workspaceReducer,
  type PaneDirection,
} from './workspace'
import { projectMuted, toggleProjectMute } from './mute'
import { UNSORTED_ID, type NotificationConfig, type TabDescriptor, type TabType } from '../shared/ipc'

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
  // Unsorted has no directory of its own, and a project whose folder has gone
  // cannot host a new terminal.
  const canOpen = Boolean(project) && project?.id !== UNSORTED_ID && project?.available === true

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
      window.prcli
        .splitPane({
          paneId: activePaneId,
          dir,
          cols: dir === 'row' ? half(grid.cols) : grid.cols,
          rows: dir === 'col' ? half(grid.rows) : grid.rows,
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
    [activePaneId, fail],
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
          {state.projects.length === 0 ? (
            <p data-testid="empty-state" className="p-4 font-mono text-[12px] text-muted">
              No projects yet. Add one to open a terminal.
            </p>
          ) : null}
          {/* Every terminal stays mounted, across every project and every tab:
              both maps below are unconditional, and neither list is filtered
              down to what is on screen. Unmounting would dispose an xterm and
              lose its scrollback on each switch. `paneGroups` decides the
              arrangement; see its tests for the arithmetic. */}
          {paneGroups(state).map((group) => (
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
                </div>
              ))}
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

