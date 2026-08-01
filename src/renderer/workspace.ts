import {
  UNSORTED_ID,
  type ProjectDescriptor,
  type TabDescriptor,
  type TabRow,
  type TabShape,
} from '../shared/ipc'
import { worst, type TabState } from '../shared/status'

export interface WorkspaceState {
  /** Sidebar order. Unsorted, when present, is last. */
  projects: ProjectDescriptor[]
  /** Every pane, flat. Which tab holds one is `tabs[].layout.kids`. */
  panes: TabDescriptor[]
  /**
   * Order, selection and layout — never existence. Main is authoritative: a
   * pane naming no row here is recorded in `panes` and left there rather than
   * invented into one.
   */
  tabs: TabRow[]
  activeProjectId: string | null
  /** What each tab is doing. A tab absent from this draws no dot. */
  status: Record<string, TabState>
  /**
   * Panes whose tmux session has died, by exit code, kept in the bar until
   * the user restarts or dismisses them.
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
      panes: TabDescriptor[]
      tabs: TabRow[]
      activeProjectId: string | null
      /**
       * Optional so a test that only cares about `projects`/`panes` need not
       * supply it — it defaults to `{}`, same as before this field existed.
       * Production code always has one: it comes from the same `restore()`
       * response as everything else here, rather than a second, separately
       * raced `status()` call — see `RestoreResult.status` in shared/ipc.ts.
       */
      status?: Record<string, TabState>
    }
  | { type: 'projects'; projects: ProjectDescriptor[] }
  | { type: 'opened'; tab: TabDescriptor }
  | { type: 'removed'; id: string }
  | { type: 'activatedTab'; id: string }
  | { type: 'activatedProject'; id: string }
  | { type: 'movedTab'; panes: TabDescriptor[]; projects: ProjectDescriptor[] }
  | { type: 'statusSnapshot'; status: Record<string, TabState> }
  | { type: 'statusChanged'; tabId: string; state: TabState | null }
  | { type: 'died'; id: string; code: number }
  | { type: 'dismissed'; id: string }
  /** What `splitPane` resolved to: the new pane, and the tab's replacement row. */
  | { type: 'split'; shape: TabShape }
  /**
   * What `closePane` resolved to. `paneId` is what was asked to close — the
   * one piece `shape` cannot carry, since a tab's last pane closing leaves
   * `shape` with nothing in it to identify which pane that was.
   */
  | { type: 'closedPane'; paneId: string; shape: TabShape }
  | { type: 'activatedPane'; tabId: string; paneId: string }

export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  projects: [],
  panes: [],
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
  return state.panes.filter((tab) => projectIdForTab(state.projects, tab) === projectId)
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
  const ranked = state.panes.filter((tab) => {
    const status = state.status[tab.id]
    return status === 'waiting' || status === 'crashed'
  })
  return ranked.sort((left, right) => {
    const order = (tab: TabDescriptor): number => (state.status[tab.id] === 'crashed' ? 0 : 1)
    return order(left) - order(right)
  })
}

/**
 * A tab's panes, in `layout.kids` order. A tab id naming no row is an empty
 * list, not an error — the rest of the plan calls this from outside a React
 * render, where "nothing to show" has to be a value, not a throw.
 */
export function panesOfTab(state: WorkspaceState, tabId: string): TabDescriptor[] {
  const row = state.tabs.find((candidate) => candidate.id === tabId)
  if (!row) return []
  const byId = new Map(state.panes.map((pane) => [pane.id, pane]))
  return row.layout.kids
    .map((id) => byId.get(id))
    .filter((pane): pane is TabDescriptor => pane !== undefined)
}

/**
 * The row whose `layout.kids` names this pane, or undefined when none does —
 * true of any pane main has not yet filed under a tab. Total, like
 * `panesOfTab`, for the same reason.
 */
export function tabOfPane(state: WorkspaceState, paneId: string): TabRow | undefined {
  return state.tabs.find((row) => row.layout.kids.includes(paneId))
}

/**
 * Folds a `TabShape` reply into state: every pane it names is upserted into
 * `state.panes` in place, with any pane not already present appended, and its
 * one row — when it has one — replaces the matching entry in `state.tabs` or
 * is appended if this tab had none yet.
 *
 * Only `split` uses this. `closedPane` looked like a second caller at first —
 * it also gets a `TabShape` back — but it needs to *remove* a pane by an id
 * `shape` may not even carry (a last-pane close hands back an empty shape
 * with nothing to name what just left) and to drop a row outright rather than
 * only ever replace or insert one. Bending this helper to also subtract would
 * make it answer two different questions through one signature; `closedPane`
 * stays its own short, honest block below instead.
 */
function applyTabShape(state: WorkspaceState, shape: TabShape): WorkspaceState {
  const panes = [
    ...state.panes.map((pane) => shape.panes.find((incoming) => incoming.id === pane.id) ?? pane),
    ...shape.panes.filter((incoming) => !state.panes.some((pane) => pane.id === incoming.id)),
  ]
  const row = shape.tabs[0]
  const tabs = row
    ? state.tabs.some((candidate) => candidate.id === row.id)
      ? state.tabs.map((candidate) => (candidate.id === row.id ? row : candidate))
      : [...state.tabs, row]
    : state.tabs
  return { ...state, panes, tabs }
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
  const tab = state.panes.find((candidate) => candidate.id === id)
  if (!tab) return state
  const owner = projectIdForTab(state.projects, tab)
  // Only the owning project's selection moves; every other project keeps
  // whichever tab it was on.
  const siblings = tabsOfProject(state, owner)
  const project = state.projects.find((candidate) => candidate.id === owner)
  const nextActive =
    project?.activeTabId === id ? neighbourOf(siblings, id) : (project?.activeTabId ?? null)
  return setActiveTab(
    { ...state, panes: state.panes.filter((candidate) => candidate.id !== id) },
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
        panes: action.panes,
        tabs: action.tabs,
        activeProjectId: action.activeProjectId,
        status: action.status ?? {},
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
      const existing = state.panes.some((tab) => tab.id === action.tab.id)
      const owner = projectIdForTab(state.projects, action.tab)
      return setActiveTab(
        {
          ...state,
          // Replaced in place on a restart, appended on a genuine open. A
          // plain append would leave two rows for one session.
          panes: existing
            ? state.panes.map((tab) => (tab.id === action.tab.id ? action.tab : tab))
            : [...state.panes, action.tab],
          dead,
        },
        owner,
        action.tab.id,
      )
    }

    case 'activatedTab': {
      const tab = state.panes.find((candidate) => candidate.id === action.id)
      if (!tab) return state
      return setActiveTab(state, projectIdForTab(state.projects, tab), action.id)
    }

    case 'activatedProject': {
      if (!state.projects.some((project) => project.id === action.id)) return state
      return { ...state, activeProjectId: action.id }
    }

    case 'removed': {
      const { [action.id]: _dropped, ...status } = state.status
      const { [action.id]: _tombstone, ...dead } = state.dead
      return { ...removeTab(state, action.id), status, dead }
    }

    case 'movedTab': {
      const stillThere = action.projects.some((project) => project.id === state.activeProjectId)
      const moved = new Map(action.panes.map((pane) => [pane.id, pane]))
      return {
        ...state,
        projects: action.projects,
        // Replaced in place: each pane keeps its position, and only its slug —
        // and therefore which project owns it — has changed. Keyed by pane id,
        // so every pane the reply names is replaced rather than only the one
        // whose id is also its tab's founder. A move renames sessions, not tab
        // membership, so `state.tabs` — one row per group, in `layout.kids` —
        // is untouched here.
        panes: state.panes.map((pane) => moved.get(pane.id) ?? pane),
        // Filing the last stray leaves nothing for Unsorted to hold, so the
        // reply drops it and the selection would dangle — the same hazard the
        // `projects` case guards. Follow the tab, so the window ends up showing
        // where it went rather than nothing at all. Any moved pane names the
        // destination: they all landed in the same project.
        activeProjectId: stillThere
          ? state.activeProjectId
          : (action.projects.find((project) => project.slug === action.panes[0]?.projectSlug)?.id ??
            action.projects[0]?.id ??
            null),
      }
    }

    case 'statusSnapshot':
      return { ...state, status: action.status }

    case 'statusChanged': {
      // Null means the tab was forgotten — dismissed, or killed on purpose —
      // not a seventh state to draw. Storing it as a value would let it slip
      // into `stateOfProject`'s ranking (it filters on `undefined`, not on
      // `null`) and it would sit in `state.status` forever, since nothing
      // else ever removes a key once `statusChanged` has written it.
      if (action.state === null) {
        const { [action.tabId]: _dropped, ...status } = state.status
        return { ...state, status }
      }
      return { ...state, status: { ...state.status, [action.tabId]: action.state } }
    }

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

    case 'split':
      return applyTabShape(state, action.shape)

    case 'closedPane': {
      // The row from before the close, found by its old `kids` — `shape`
      // alone cannot tell us which pane just left, since closing a tab's last
      // pane hands back an empty `panes` and an empty `tabs` with nothing in
      // either to name it.
      const priorRow = state.tabs.find((row) => row.layout.kids.includes(action.paneId))
      const panes = state.panes.filter((pane) => pane.id !== action.paneId)
      const nextRow = action.shape.tabs[0]
      const tabs = priorRow
        ? nextRow
          ? // Row ids are frozen to the founder pane, so `nextRow.id` is always
            // `priorRow.id` here — never a rename to chase.
            state.tabs.map((row) => (row.id === priorRow.id ? nextRow : row))
          : state.tabs.filter((row) => row.id !== priorRow.id)
        : state.tabs
      return { ...state, panes, tabs }
    }

    case 'activatedPane': {
      if (!state.tabs.some((row) => row.id === action.tabId)) return state
      return {
        ...state,
        tabs: state.tabs.map((row) =>
          row.id === action.tabId ? { ...row, activePaneId: action.paneId } : row,
        ),
      }
    }
  }
}
