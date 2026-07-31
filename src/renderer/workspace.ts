import { UNSORTED_ID, type ProjectDescriptor, type TabDescriptor } from '../shared/ipc'
import { worst, type TabState } from '../shared/status'

export interface WorkspaceState {
  /** Sidebar order. Unsorted, when present, is last. */
  projects: ProjectDescriptor[]
  /** Every tab across every project. The tab bar filters this. */
  tabs: TabDescriptor[]
  activeProjectId: string | null
  /** What each tab is doing. A tab absent from this draws no dot. */
  status: Record<string, TabState>
  /**
   * Tabs whose tmux session has died, by exit code, kept in the bar until the
   * user restarts or dismisses them.
   *
   * Renderer-side only: main forgot the row when the session died and config
   * is written from live state, so none of this reaches disk and a relaunch
   * prunes it exactly as it always has. That is what makes tombstones free of
   * any migration.
   */
  dead: Record<string, number>
}

export type WorkspaceAction =
  | {
      type: 'restored'
      projects: ProjectDescriptor[]
      tabs: TabDescriptor[]
      activeProjectId: string | null
    }
  | { type: 'projects'; projects: ProjectDescriptor[] }
  | { type: 'opened'; tab: TabDescriptor }
  | { type: 'removed'; id: string }
  | { type: 'activatedTab'; id: string }
  | { type: 'activatedProject'; id: string }
  | { type: 'movedTab'; tab: TabDescriptor; projects: ProjectDescriptor[] }
  | { type: 'statusSnapshot'; status: Record<string, TabState> }
  | { type: 'statusChanged'; tabId: string; state: TabState }
  | { type: 'died'; id: string; code: number }
  | { type: 'dismissed'; id: string }

export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  projects: [],
  tabs: [],
  activeProjectId: null,
  status: {},
  dead: {},
}

/**
 * Which tab to show once `id` goes away: the one to its right, or its left
 * when it was last. Null when it was the only one.
 */
export function neighbourOf(tabs: TabDescriptor[], id: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return null
  const next = tabs[index + 1] ?? tabs[index - 1]
  return next?.id ?? null
}

/**
 * The project a tab belongs to, derived from the slug in its session name.
 *
 * Nothing stores this association, so it cannot go stale — and a tab whose
 * slug no project owns is, by definition, Unsorted.
 */
export function projectIdForTab(projects: ProjectDescriptor[], tab: TabDescriptor): string {
  return projects.find((project) => project.slug === tab.projectSlug)?.id ?? UNSORTED_ID
}

export function tabsOfProject(state: WorkspaceState, projectId: string): TabDescriptor[] {
  return state.tabs.filter((tab) => projectIdForTab(state.projects, tab) === projectId)
}

export function activeProject(state: WorkspaceState): ProjectDescriptor | undefined {
  return state.projects.find((project) => project.id === state.activeProjectId)
}

/** The active tab is a property of the active project, not of the workspace. */
export function activeTabId(state: WorkspaceState): string | null {
  return activeProject(state)?.activeTabId ?? null
}

/** Null means "draw no dot", which is not the same as `unknown`. */
export function stateOfTab(state: WorkspaceState, id: string): TabState | null {
  return state.status[id] ?? null
}

/** A project row takes the worst state among its tabs. */
export function stateOfProject(state: WorkspaceState, projectId: string): TabState | null {
  const states = tabsOfProject(state, projectId)
    .map((tab) => state.status[tab.id])
    .filter((candidate): candidate is TabState => candidate !== undefined)
  return worst(states)
}

/**
 * Every tab that is blocking a human, worst first.
 *
 * `waiting` and `crashed` only: those are the two states that mean someone has
 * to do something. A list that also held `thinking` would be a list of
 * everything, which is the sidebar you already have.
 */
export function needsYou(state: WorkspaceState): TabDescriptor[] {
  const ranked = state.tabs.filter((tab) => {
    const status = state.status[tab.id]
    return status === 'waiting' || status === 'crashed'
  })
  return ranked.sort((left, right) => {
    const order = (tab: TabDescriptor): number => (state.status[tab.id] === 'crashed' ? 0 : 1)
    return order(left) - order(right)
  })
}

function setActiveTab(
  state: WorkspaceState,
  projectId: string,
  activeTabId: string | null,
): WorkspaceState {
  return {
    ...state,
    projects: state.projects.map((project) =>
      project.id === projectId ? { ...project, activeTabId } : project,
    ),
  }
}

/**
 * Drop a tab and, if it was the active one, hand the selection to its
 * neighbour. Shared by `removed` and `dismissed` so the neighbour rule is
 * written once.
 */
function removeTab(state: WorkspaceState, id: string): WorkspaceState {
  const tab = state.tabs.find((candidate) => candidate.id === id)
  if (!tab) return state
  const owner = projectIdForTab(state.projects, tab)
  // Only the owning project's selection moves; every other project keeps
  // whichever tab it was on.
  const siblings = tabsOfProject(state, owner)
  const project = state.projects.find((candidate) => candidate.id === owner)
  const nextActive =
    project?.activeTabId === id ? neighbourOf(siblings, id) : (project?.activeTabId ?? null)
  return setActiveTab(
    { ...state, tabs: state.tabs.filter((candidate) => candidate.id !== id) },
    owner,
    nextActive,
  )
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case 'restored':
      return {
        projects: action.projects,
        tabs: action.tabs,
        activeProjectId: action.activeProjectId,
        status: {},
        dead: {},
      }

    case 'projects': {
      const stillThere = action.projects.some((project) => project.id === state.activeProjectId)
      return {
        ...state,
        projects: action.projects,
        // A removed project must not leave the window pointing at nothing.
        activeProjectId: stillThere ? state.activeProjectId : (action.projects[0]?.id ?? null),
      }
    }

    case 'opened': {
      const { [action.tab.id]: _revived, ...dead } = state.dead
      const existing = state.tabs.some((tab) => tab.id === action.tab.id)
      const owner = projectIdForTab(state.projects, action.tab)
      return setActiveTab(
        {
          ...state,
          // Replaced in place on a restart, appended on a genuine open. A
          // plain append would leave two rows for one session.
          tabs: existing
            ? state.tabs.map((tab) => (tab.id === action.tab.id ? action.tab : tab))
            : [...state.tabs, action.tab],
          dead,
        },
        owner,
        action.tab.id,
      )
    }

    case 'activatedTab': {
      const tab = state.tabs.find((candidate) => candidate.id === action.id)
      if (!tab) return state
      return setActiveTab(state, projectIdForTab(state.projects, tab), action.id)
    }

    case 'activatedProject': {
      if (!state.projects.some((project) => project.id === action.id)) return state
      return { ...state, activeProjectId: action.id }
    }

    case 'removed': {
      const { [action.id]: _dropped, ...status } = state.status
      return { ...removeTab(state, action.id), status }
    }

    case 'movedTab': {
      const stillThere = action.projects.some((project) => project.id === state.activeProjectId)
      return {
        ...state,
        projects: action.projects,
        // Replaced in place: the tab keeps its position, and only its slug —
        // and therefore which project owns it — has changed.
        tabs: state.tabs.map((tab) => (tab.id === action.tab.id ? action.tab : tab)),
        // Filing the last stray leaves nothing for Unsorted to hold, so the
        // reply drops it and the selection would dangle — the same hazard the
        // `projects` case guards. Follow the tab, so the window ends up showing
        // where it went rather than nothing at all.
        activeProjectId: stillThere
          ? state.activeProjectId
          : (action.projects.find((project) => project.slug === action.tab.projectSlug)?.id ??
            action.projects[0]?.id ??
            null),
      }
    }

    case 'statusSnapshot':
      return { ...state, status: action.status }

    case 'statusChanged':
      return { ...state, status: { ...state.status, [action.tabId]: action.state } }

    case 'died':
      // Deliberately keeps the tab, and keeps it selected. Its scrollback is
      // the only record of why it died, and dropping it is what made `crashed`
      // a state nothing could ever render.
      return { ...state, dead: { ...state.dead, [action.id]: action.code } }

    case 'dismissed': {
      const { [action.id]: _dropped, ...dead } = state.dead
      // Same selection move a close makes, so dismissing the tab you are
      // looking at does not leave the pane showing nothing.
      return { ...removeTab(state, action.id), dead }
    }
  }
}
