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
import { UNSORTED_ID, type NotificationConfig, type TabDescriptor } from '../shared/ipc'

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

  const launch = useCallback(
    (command?: string) => {
      if (!project || !canOpen) return
      window.prcli
        .open({ projectSlug: project.slug, cwd: project.cwd, command })
        .then((tab) => dispatch({ type: 'opened', tab }))
        .catch(fail)
    },
    [project, canOpen, fail],
  )

  const openTab = useCallback(() => launch(), [launch])

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
      const [{ projects, tabs, activeProjectId }, status, notificationConfig] = await Promise.all(
        [window.prcli.restore(), window.prcli.status(), window.prcli.notifications()],
      )
      if (cancelled) return
      dispatch({ type: 'restored', projects, tabs, activeProjectId })
      dispatch({ type: 'statusSnapshot', status })
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
      window.prcli.onExit(({ id, code, sessionAlive }) => {
        if (sessionAlive) return
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey) return

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
          // Renames the tmux session. The tab id is the other half of the
          // name, so it keeps its scrollback and everything running in it.
          window.prcli
            .moveTabToProject(tabId, projectId)
            .then(({ projects, tab }) => dispatch({ type: 'movedTab', tab, projects }))
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

      {panelOpen ? <RightPanel project={project} onRun={(command) => launch(command)} /> : null}

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

