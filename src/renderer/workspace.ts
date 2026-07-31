import { UNSORTED_ID, type ProjectDescriptor, type TabDescriptor } from '../shared/ipc'

export interface WorkspaceState {
  /** Sidebar order. Unsorted, when present, is last. */
  projects: ProjectDescriptor[]
  /** Every tab across every project. The tab bar filters this. */
  tabs: TabDescriptor[]
  activeProjectId: string | null
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

export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  projects: [],
  tabs: [],
  activeProjectId: null,
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
      if (state.tabs.some((tab) => tab.id === action.tab.id)) return state
      const owner = projectIdForTab(state.projects, action.tab)
      return setActiveTab(
        { ...state, tabs: [...state.tabs, action.tab] },
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
      const tab = state.tabs.find((candidate) => candidate.id === action.id)
      if (!tab) return state
      const owner = projectIdForTab(state.projects, tab)
      // Only the owning project's selection moves; every other project keeps
      // whichever tab it was on.
      const siblings = tabsOfProject(state, owner)
      const project = state.projects.find((candidate) => candidate.id === owner)
      const nextActive =
        project?.activeTabId === action.id
          ? neighbourOf(siblings, action.id)
          : (project?.activeTabId ?? null)
      return setActiveTab(
        { ...state, tabs: state.tabs.filter((candidate) => candidate.id !== action.id) },
        owner,
        nextActive,
      )
    }

    case 'movedTab':
      return {
        ...state,
        projects: action.projects,
        // Replaced in place: the tab keeps its position, and only its slug —
        // and therefore which project owns it — has changed.
        tabs: state.tabs.map((tab) => (tab.id === action.tab.id ? action.tab : tab)),
      }
  }
}
