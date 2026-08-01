import { useCallback, useEffect, useReducer, useState } from 'react'
import { Terminal } from './Terminal'
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
  projectIdForTab,
  stateOfProject,
  tabsOfProject,
  workspaceReducer,
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

  const closeTab = useCallback(
    (id: string) => {
      window.prcli
        .kill(id)
        .then(() => dispatch({ type: 'removed', id }))
        .catch(fail)
    },
    [fail],
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
      //
      // `panes` only, for now: the reply also carries `tabs` — layout, one
      // row per group — but nothing downstream reads it until a later
      // milestone task turns it into a real split.
      const [{ projects, panes, activeProjectId, status }, notificationConfig] = await Promise.all([
        window.prcli.restore(),
        window.prcli.notifications(),
      ])
      if (cancelled) return
      dispatch({ type: 'restored', projects, tabs: panes, activeProjectId, status })
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
  // the one on screen. Depends on `state.tabs`/`state.projects` rather than
  // `[]` so the closure always has the current lookup tables instead of the
  // ones from first mount — the resubscribe this costs is a synchronous
  // `removeListener`/`on` pair on every workspace change, cheap next to a
  // stale closure silently failing to find a tab that has since moved.
  useEffect(
    () =>
      window.prcli.onFocusTab((tabId) => {
        const tab = state.tabs.find((candidate) => candidate.id === tabId)
        if (!tab) return
        dispatch({ type: 'activatedProject', id: projectIdForTab(state.projects, tab) })
        dispatch({ type: 'activatedTab', id: tabId })
      }),
    [state.tabs, state.projects],
  )

  const restartTab = useCallback(
    (tab: TabDescriptor) => {
      // No explicit cols/rows: the tab's Terminal is still mounted, so
      // `register.ts`'s `lastGeometry` — the size its last resize reported —
      // is what main attaches at, and the fit that follows the reattach
      // corrects anything stale. The renderer has nothing fresher to offer.
      //
      // No `tabId` either, and that is only correct while every tab here is
      // one pane: main then reads this pane's own id as the tab id, which is
      // right for a one-pane tab and for the founder of a split, and wrong for
      // any other pane of one — it comes back outside its tab's group. The
      // moment this app draws a split and offers Restart on a pane inside it,
      // this call has to send the id of the tab that holds the pane. See
      // `RestartRequest.tabId`.
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
          case 'closeTab':
            // Same guard the ⌘W handler applies: with no tab there is nothing
            // to close, and closeTab(null) is not a thing to ask for.
            if (currentTabId) closeTab(currentTabId)
            return
          case 'togglePresets':
            setPanelOpen((open) => !open)
            return
          case 'settings':
            setSettingsOpen(true)
        }
      }),
    [currentTabId, openTab, closeTab],
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
      if (event.code === 'KeyW' && !event.altKey && currentTabId) {
        event.preventDefault()
        closeTab(currentTabId)
        return
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
  }, [currentTabId, currentTabs, state.projects, openTab, closeTab])

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
          onClose={closeTab}
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
          {/* Every terminal stays mounted, across every project. Unmounting
              would dispose its xterm and lose scrollback on each switch. */}
          {state.tabs.map((tab) => {
            const visible = tab.id === currentTabId
            return (
              <div
                key={tab.id}
                data-testid={visible ? 'terminal-active' : `terminal-${tab.id}`}
                className={cn(
                  // `visibility`, not `display`: a hidden tab must stay laid
                  // out so it can measure itself, or it attaches at 80×24 and
                  // tmux shrinks the real session to match.
                  'absolute inset-0 p-2',
                  visible ? 'visible z-10' : 'invisible z-0 pointer-events-none',
                )}
              >
                <Terminal tabId={tab.id} visible={visible} />
              </div>
            )
          })}
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

