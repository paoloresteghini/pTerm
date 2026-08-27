import {
  UNSORTED_ID,
  canHaveSession,
  regionOf,
  type JoinShape,
  type ProjectDescriptor,
  type Region,
  type TabDescriptor,
  type TabRow,
  type TabShape,
} from '../shared/ipc'
import { worst, type TabState } from '../shared/status'
import { groupedTabs } from './lib/tabGroups'
import { cellRect, type CellRect } from './lib/wallLayout'

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
  /**
   * What each PANE is doing, keyed by pane id: main's registry keys by the
   * session id it sends hook events under, and every pane is its own session.
   * A pane absent from this draws no dot; a tab's dot is the worst of its
   * panes' entries, which is `stateOfTab`.
   */
  status: Record<string, TabState>
  /**
   * When each tab entered its current state, epoch ms, for the elapsed label.
   *
   * A map beside `status` rather than a field on it: `status`'s shape is read
   * in several places and widening it for one label would touch all of them.
   * A tab absent here simply gets no label.
   */
  since: Record<string, number>
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
  /**
   * **Nothing dispatches this.** ⌘W, the tab bar's × and the menu item all
   * became `closedPane` when `CHANNELS.kill` was collapsed into
   * `CHANNELS.closePane`. It drops a pane, its status and its tombstone but
   * does NOT maintain the tab's layout row, so reaching for it on a split tab
   * leaves exactly the stale row that collapse removed from the main process —
   * the same drift, one level down. Use `closedPane`. Kept for now rather than
   * deleted along with the tests that still describe it; collapsing the two is
   * a ledger item, not an oversight.
   */
  | { type: 'removed'; id: string }
  | { type: 'activatedTab'; id: string }
  | { type: 'activatedProject'; id: string }
  | { type: 'movedTab'; panes: TabDescriptor[]; projects: ProjectDescriptor[] }
  | { type: 'panesMerged'; panes: TabDescriptor[] }
  | { type: 'statusSnapshot'; status: Record<string, TabState>; since?: Record<string, number> }
  | { type: 'statusChanged'; tabId: string; state: TabState | null; since?: number | null }
  | { type: 'died'; id: string; code: number }
  | { type: 'dismissed'; id: string }
  /** What `splitPane` resolved to: the new pane, and the tab's replacement row. */
  | { type: 'split'; shape: TabShape }
  /** What `joinPane` resolved to: the target row, and the source row when it survived. */
  | { type: 'joined'; shape: JoinShape }
  /**
   * What `closePane` resolved to. `paneId` is what was asked to close — the
   * one piece `shape` cannot carry, since a tab's last pane closing leaves
   * `shape` with nothing in it to identify which pane that was.
   */
  | { type: 'closedPane'; paneId: string; shape: TabShape }
  | { type: 'activatedPane'; tabId: string; paneId: string }
  /**
   * A drag in progress. Ratios only — a drag never changes membership, and the
   * reducer is where they live during the gesture so `paneGroups` reflows the
   * panes and `Terminal.tsx`'s ResizeObserver drives tmux with no second push
   * path. Persistence waits for the pointer to come up; see `CHANNELS.setLayout`.
   */
  | { type: 'resized'; tabId: string; ratio: number[] }

export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  projects: [],
  panes: [],
  tabs: [],
  activeProjectId: null,
  status: {},
  since: {},
  dead: {},
}

/**
 * Which tab to show once `id` goes away: the one to its right, or its left
 * when it was last. Null when it was the only one.
 *
 * Purely positional in `tabs`, so "right" means what is on screen only when
 * `tabs` is already in the bar's own order. A split's sibling is not next to
 * its founder in raw `state.panes` order (`applyTabShape`, below in this file,
 * appends it), so both call sites below pass `groupedTabs`' output rather
 * than a bare `tabsOfProject` filter.
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

/**
 * `region` filters to one column; omitted, every pane of the project comes
 * back regardless of column, which is the behaviour before regions existed
 * and is what keeps a call site that has not been updated working.
 */
export function tabsOfProject(
  state: WorkspaceState,
  projectId: string,
  region?: Region,
): TabDescriptor[] {
  return state.panes.filter(
    (tab) =>
      projectIdForTab(state.projects, tab) === projectId &&
      (region === undefined || regionOf(tab) === region),
  )
}

export function activeProject(state: WorkspaceState): ProjectDescriptor | undefined {
  return state.projects.find((project) => project.id === state.activeProjectId)
}

/**
 * Which of a project's two selection fields a region owns.
 *
 * One mapping, read by `selectionOf` below and written through by
 * `setActiveTab`. Every one of those sites used to spell the choice out as its
 * own ternary, which is four copies of a rule that is really about the shape
 * of `ProjectDescriptor`, and a third region would have to find all four.
 */
const SELECTION_FIELD: Record<Region, 'activeTabId' | 'activeBrowserTabId'> = {
  terminal: 'activeTabId',
  browser: 'activeBrowserTabId',
}

/**
 * One project's selection in one region, absent spelled as null.
 *
 * `activeTabId` below answers for the ACTIVE project only, and the reducer's
 * close paths need the same answer about the project that owned the pane, so
 * the rule lives here rather than inside it. `activeBrowserTabId` is optional
 * on `ProjectDescriptor` (see its comment there), which is why this collapses
 * `undefined` as well as a missing project.
 *
 * Not exported: `activeTabId` is the answer every caller outside this file
 * wants. Three sites call this one directly, all of them in this file:
 * `activeTabId` just below, and the reducer's two close paths, `removeTab`
 * and `closedPane`.
 */
function selectionOf(project: ProjectDescriptor | undefined, region: Region): string | null {
  return project?.[SELECTION_FIELD[region]] ?? null
}

/**
 * The active tab is a property of the active project, not of the workspace.
 *
 * Defaults to `'terminal'`, the region this returned before `region` existed,
 * so a call site that has not been updated keeps reading the terminal
 * column's selection exactly as before.
 */
export function activeTabId(state: WorkspaceState, region: Region = 'terminal'): string | null {
  return selectionOf(activeProject(state), region)
}

/**
 * Whether `Cmd+T` (and the tab bar's `+`) can open a session right now: a
 * project is active, it is not Unsorted, and its cwd is on disk.
 *
 * Unsorted has no directory of its own, and a project whose folder has gone
 * cannot host a new terminal.
 *
 * The one place this three-part test is written. `App.tsx`'s `launch` gates
 * on it directly, and `welcomeHint` reads it for its "press Cmd+T" case: a
 * fourth condition added here changes both call sites at once, rather than
 * leaving a second copy free to drift and the welcome page free to keep
 * saying `press Cmd+T to start a session` while the keystroke does nothing.
 */
export function canOpenSession(state: WorkspaceState): boolean {
  const project = activeProject(state)
  return Boolean(project) && project?.id !== UNSORTED_ID && project?.available === true
}

/**
 * One pane's own state. Null means "draw no dot", which is not the same as
 * `unknown`.
 *
 * Per pane, and staying that way: the tab bar lists panes, one entry each, so
 * its dots answer for a pane and not for the tab around it. The fold that
 * answers for a whole tab is `stateOfTab`, below — two names, because they are
 * two questions, and a split tab is exactly where the answers diverge.
 */
export function stateOfPane(state: WorkspaceState, paneId: string): TabState | null {
  return state.status[paneId] ?? null
}

/**
 * The panes a group id stands for: a row's, or the one pane that names itself.
 *
 * The same dichotomy `paneGroups` draws, and for the same reason — a pane no
 * row names is a group of its own, keyed by its own id, which is every tab
 * opened this run and never split. Without this branch such a tab would fold
 * over nothing and lose its dot the moment aggregation arrived.
 */
function panesOfGroup(state: WorkspaceState, groupId: string): TabDescriptor[] {
  const panes = panesOfTab(state, groupId)
  if (panes.length > 0) return panes
  const lone = state.panes.find((pane) => pane.id === groupId)
  return lone ? [lone] : []
}

/**
 * A tab's dot: the worst state among its panes, by the order in
 * `shared/status.ts`.
 *
 * The failure this exists to prevent is a split tab reported by one of its
 * panes — a crashed second pane leaving the tab green on a tool whose whole job
 * is saying which session needs a human. The ranking itself is not here: it is
 * reached through `worst`, whose one reading of `SEVERITY` is also the one main
 * fires notifications off and the dock badge counts. A copy of that order in
 * this file would be a copy that can disagree with the badge, which is what
 * `shared/status.ts`'s own comment asks the next person not to write.
 *
 * `state.dead` is deliberately not consulted. The exit code kept there is the
 * *attach client's*, and it is 0 however the pane died; what actually killed a
 * pane is read off tmux's `pane_dead_status` and arrives in `state.status` like
 * every other state. See `PaneBox.dead`.
 *
 * Null when no pane of the tab has a state at all — "draw no dot". A tab whose
 * panes have all reported `unknown` is `unknown`, which `worst` gives without
 * help: `unknown` is in `SEVERITY`, and only an empty list falls off the end.
 *
 * **Nothing outside this file calls this yet, and that is not an oversight:**
 * the tab bar lists panes, one entry each with its own dot, so no element on
 * screen today stands for a whole tab and none of them lies. `stateOfProject`
 * is the only caller. **The moment a tab-bar entry stands for a tab — the `⊞n`
 * badge, or any other collapse of a split tab into one row — that entry's dot
 * must come from here.** Reading `status[tab.id]` for it instead is the exact
 * defect this function was written ahead of: the founder pane's state, wearing
 * the whole tab's dot, showing green over a crashed sibling.
 */
export function stateOfTab(state: WorkspaceState, tabId: string): TabState | null {
  const states = panesOfGroup(state, tabId)
    .map((pane) => state.status[pane.id])
    .filter((candidate): candidate is TabState => candidate !== undefined)
  return worst(states)
}

/**
 * A project row takes the worst state among its tabs.
 *
 * Structurally the worst of the tab dots, rather than a second fold straight
 * over the project's panes that would happen to agree with them: one rule, at
 * both levels, so neither can be changed without the other.
 *
 * The tabs are found through the project's panes, since nothing stores which
 * project owns a *tab* — a tab is owned by the slug its panes carry. A tab
 * whose panes disagree about that is a move that half-landed, and it is then
 * listed under both projects, each row reporting the whole tab. That
 * over-reports rather than under-reports, which is the safe direction for a dot
 * whose only job is to make you look.
 */
export function stateOfProject(state: WorkspaceState, projectId: string): TabState | null {
  const groups = new Set(
    tabsOfProject(state, projectId).map((pane) => tabOfPane(state, pane.id)?.id ?? pane.id),
  )
  const states = [...groups]
    .map((tabId) => stateOfTab(state, tabId))
    .filter((candidate): candidate is TabState => candidate !== null)
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
    // An editor pane cannot be blocking anyone: there is no process in it to
    // ask a question or to crash. It has no state in main's registry either,
    // so in a state assembled the ordinary way this filters nothing out and
    // the guard is about what a stale config row or a misrouted event could
    // put in `status`. Local here rather than left to main's registry never
    // registering one, because the sidebar's list and the dock badge are the
    // two things this app exists to keep honest.
    if (!canHaveSession(tab)) return false
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
 * Which way a movement points. The axis half of it is the tab's own `dir`:
 * left/right walk a `row` tab, up/down a `col` one.
 */
export type PaneDirection = 'left' | 'right' | 'up' | 'down'

/**
 * The pane one step from `paneId` along its tab's axis.
 *
 * Undefined is four different "no" answers, and every one of them is the same
 * no-op for the caller: the pane is in no tab, the direction is across the
 * tab's axis (⌘⌥↑ on a `row` tab), the pane is already at that end, or the id
 * names nothing. Total, like `panesOfTab` and `tabOfPane`, for the reason
 * given there.
 *
 * Falling off the end is undefined rather than the pane at the other end:
 * wrapping puts focus at the far side of the screen from where the key
 * pointed.
 *
 * Named here, beside the two lookups it is built from, because the step is not
 * a single call in terms of either: `panesOfTab` needs a tab id and the caller
 * has a pane id, and neither answers "one along" — so every call site would
 * otherwise compose `tabOfPane`, `panesOfTab` and a `findIndex` inline.
 *
 * The step is over `panesOfTab` rather than over `kids` directly, so it lands
 * on the pane drawn next: `paneGroups` boxes exactly the kids whose panes
 * exist, so a kid without one is on screen nowhere and stepping onto it would
 * move focus to nothing.
 */
export function paneInDirection(
  state: WorkspaceState,
  paneId: string,
  direction: PaneDirection,
): TabDescriptor | undefined {
  const row = tabOfPane(state, paneId)
  if (!row) return undefined
  const axis = direction === 'left' || direction === 'right' ? 'row' : 'col'
  if (row.layout.dir !== axis) return undefined
  const panes = panesOfTab(state, row.id)
  const at = panes.findIndex((pane) => pane.id === paneId)
  if (at === -1) return undefined
  // `panes[-1]` and `panes[length]` are both undefined, which is the no-wrap
  // answer without a bounds test of its own.
  return panes[at + (direction === 'right' || direction === 'down' ? 1 : -1)]
}

/**
 * A floor of `cells` expressed as a fraction of an axis `totalCells` long.
 *
 * Cells, not percent, because what makes a terminal unusable is column count —
 * 80-column output wrapping — and not its share of a window. A percentage floor
 * misses that at exactly the sizes where it matters.
 *
 * Capped at 1, and 0 for an unmeasured axis. Neither is decoration: an
 * uncapped value above 1 would make `resizeKids`' bounds cross on a tab that is
 * merely small rather than genuinely squeezed, and `cells / 0` is `Infinity`,
 * which would poison every comparison it reached.
 */
export function minRatioFor(cells: number, totalCells: number): number {
  if (totalCells <= 0) return 0
  return Math.min(1, cells / totalCells)
}

/**
 * A drag of the divider between kid `index` and kid `index + 1`.
 *
 * Share moves between exactly those two; every other kid is untouched. That is
 * what makes the sum invariant BY CONSTRUCTION — what one loses the other
 * gains — so there is no rescale step here and nothing for a rescale to get
 * wrong. Plan 2b's Critical had a share bug behind it, and the branch that
 * renormalised every share alike was the part that resized a pane nobody had
 * touched.
 *
 * **The clamp is on the movement, not on the result.** A pane already below its
 * floor — squeezed there by a narrow window, which ruling 4 allows — is never
 * made worse by a drag, and can still be dragged back open. Validating the
 * outcome instead would freeze such a pane at its size for good.
 *
 * Both bounds are clamped through zero, so "no movement" is always a legal
 * answer: `lower` is at most 0, `upper` is at least 0. A kid already below its
 * floor makes the OTHER bound — the one that would shrink it further — clamp
 * to 0 rather than going positive; growing it back toward its floor is still
 * open on the bound that lets it. When both kids are below their floors, both
 * bounds land on exactly 0 and the only room is none, which is the honest
 * answer: no move satisfies both floors, so nothing moves.
 */
export function resizeKids(
  ratio: readonly number[],
  index: number,
  delta: number,
  minLow: number,
  minHigh: number,
): number[] {
  const low = ratio[index]
  const high = ratio[index + 1]
  // A divider with nothing on one side of it. Total, like every other lookup
  // in this file, because the caller is a pointer handler where "no such pair"
  // has to be a value rather than a throw.
  if (low === undefined || high === undefined) return [...ratio]

  const lower = Math.min(0, minLow - low)
  const upper = Math.max(0, high - minHigh)
  const room = Math.min(Math.max(delta, lower), upper)
  const next = [...ratio]
  next[index] = low + room
  next[index + 1] = high - room
  return next
}

/**
 * Take hold of the divider before box `index` of `row`, or refuse to.
 *
 * `boxes` are what is on screen; `row.layout.ratio` is what is stored, and the
 * two are not always the same list. `boxesOfRow` drops kids whose panes are
 * absent — or named twice — and renormalises what is left, so a box index is
 * not a kid index and an on-screen share is not a stored one. Applying a
 * delta measured against the screen to un-renormalised stored ratios, at an
 * index that has slid, is the shape of plan 2b's Critical: a pane nobody
 * touched changing size.
 *
 * So the whole question is settled here, once, and in the screen's own units.
 * Equal lengths mean nothing was dropped, which makes the boxes the kids in
 * kids order — checked by identity at the pair being dragged rather than
 * inferred, so the coupling to `boxesOfRow` is stated instead of assumed. The
 * ratio then taken is the boxes' own shares, which sum to 1 by construction,
 * so the delta, the floor and the stored ratio are all fractions of the same
 * axis. Anything else about the row and this refuses, leaving the caller with
 * null, and the drag does nothing at all.
 *
 * The floor is computed here rather than in the divider because this is where
 * the cell size is reachable: `gridOf` reports a mounted terminal's grid, and
 * the box's own share says what fraction of the axis that grid covers, so the
 * axis total falls out without measuring the DOM. Either adjacent pane can
 * supply it — every terminal is built with the same font — so the low side is
 * taken, and the choice is noted here so nobody has to wonder whether it
 * mattered. Captured once, at the grab, rather than recomputed per frame: the
 * share moves as the drag runs but the grid only catches up when tmux does, so
 * a per-frame reading would divide a fresh share by a stale grid and make the
 * floor jitter mid-drag. The window is not being resized while a divider is
 * being held.
 *
 * Lives here, and not in `App.tsx` where it was written, because it is
 * arithmetic and `App.tsx` had the only copy of it: nothing outside a running
 * app ever executed it, and `dividers.test.ts`'s own header records a static
 * source check measured unable to see any of the three things that could go
 * wrong in it — the identity guards being deleted, `minRatioFor`'s two
 * arguments being swapped, and the `/` in the axis derivation becoming a `*`.
 * `gridOf` is taken as a callback rather than importing `paneGrid` directly so
 * this file stays DOM-free — `Terminal.tsx`, where `paneGrid` lives, is not,
 * and this unit suite has no DOM to mount a terminal in.
 */
export function grabFor(
  row: TabRow,
  boxes: readonly PaneBox[],
  index: number,
  // `| null` alongside `| undefined`: `Terminal.tsx`'s `paneGrid` — the
  // production caller — reports an unmounted terminal as `null`, and the test
  // double above reports it as `undefined`. `!grid` below treats them alike,
  // so the wider union costs nothing and lets `App.tsx` pass `paneGrid`
  // straight through rather than wrapping it to paper over the mismatch.
  gridOf: (paneId: string) => { cols: number; rows: number } | null | undefined,
  floors: { cols: number; rows: number },
): { at: number; ratio: number[]; min: number } | null {
  const low = boxes[index - 1]
  const high = boxes[index]
  if (!low || !high) return null
  if (boxes.length !== row.layout.kids.length) return null
  if (row.layout.kids[index - 1] !== low.pane.id) return null
  if (row.layout.kids[index] !== high.pane.id) return null
  const grid = gridOf(low.pane.id)
  if (!grid || low.share <= 0) return null
  const gridCells = row.layout.dir === 'row' ? grid.cols : grid.rows
  // A mounted terminal that has not yet reported real dimensions on this
  // axis. `axisCells` below would still come out non-positive, and
  // `minRatioFor` would answer a floor of 0 for it — the value that lets
  // `resizeKids` push a share to 0. Refusing here, where the unmeasured axis
  // is known by name, means no such share is ever computed for a later step
  // to route through.
  if (gridCells <= 0) return null
  const axisCells = gridCells / low.share
  const floor = row.layout.dir === 'row' ? floors.cols : floors.rows
  return { at: index - 1, ratio: boxes.map((box) => box.share), min: minRatioFor(floor, axisCells) }
}

/** A pane and the share of its tab's axis it takes. */
export interface PaneBox {
  pane: TabDescriptor
  /**
   * The fraction of its tab's axis this box takes, after renormalising.
   *
   * Published as a number as well as a `flexBasis` string because the dividers
   * sit at cumulative boundaries and have to add these up. Parsing the percent
   * back out of the string would make a value formatted for CSS the source of
   * truth for arithmetic — and `percent()` rounds to four places, so it is
   * lossy in exactly the direction that accumulates.
   */
  share: number
  /**
   * `flexBasis` only, so a pane states its share without knowing which axis
   * its tab flexes along — that is the container's `flexDirection`, and the
   * basis follows whichever one it is.
   */
  style: { flexBasis: string }
  /**
   * Whether this pane's tmux session has died — the one thing about a box that
   * is not geometry, here because it is decided per box and nowhere else can
   * decide it once: `paneGroups` builds boxes down two branches, and a caller
   * re-reading `state.dead` beside the render would be a second rule to keep in
   * step with this one.
   *
   * A boolean, not the exit code `state.dead` holds, and that is deliberate:
   * the code there is the code the *attach client* stopped with, not the one
   * the user's process reported — and for a pane death it is 0 whichever way
   * the pane went, which is what `StatusRegistry.applyDead` means by "always 0
   * regardless of what happened" and why the real verdict is read off tmux's
   * own `pane_dead_status` and sent down the status channel instead. Carrying
   * that number here would invite it onto the screen, where it would answer a
   * segfault with a clean 0. What killed a pane belongs to `state.status`, and
   * its colour to `StatusDot` — the only place a state becomes one.
   *
   * Required rather than optional so neither branch can quietly omit it.
   */
  dead: boolean
}

/**
 * One container's worth of render: a tab's panes along its axis, or a single
 * pane no row has claimed.
 *
 * A pane in `state.panes` that no row's `kids` names is not an error and not
 * something to drop — main is authoritative over membership and files it on
 * its own schedule, and `opened` (a new tab, a restart, or a browser pane an
 * agent's tool call asked main for: see `onBrowserPaneOpened` in `App.tsx`)
 * adds a pane here
 * with no row at all. Such a pane becomes a group of its own, keyed by its own
 * id. That key is what makes the arrangement safe: a row id is its founder
 * pane's id, so when a row does arrive for that pane — only a split of it can
 * produce one — the group's id does not change, React reconciles it as the
 * same container, and the terminal inside is never unmounted.
 *
 * **That reasoning only ever covered a row ARRIVING for a stray, and the
 * opposite direction was a defect for as long as it went unwritten.** A row
 * that LOSES its founder while the founder is still in `state.panes` — which is
 * exactly a founder pane that has died and left a tombstone — makes a stray
 * whose own id is that row's id. The two then collide in `seen` below, and
 * whichever is walked second is skipped entirely: in `state.panes` order that
 * is every LIVE pane of the tab, each one unmounted and its scrollback
 * destroyed. What keeps a row from losing its founder is `withKeptPanes`, in
 * the reducer, which puts a tombstoned kid back into the row main sent without
 * it. The invariant this key relies on is therefore not free — it is
 * maintained there, and a change that stops maintaining it lands here.
 */
export interface PaneGroup {
  /** The row's id, or the pane's own when no row names it. */
  id: string
  visible: boolean
  style: { flexDirection: 'row' | 'column' }
  /**
   * Where this group sits in the terminal column, when the wall is on and this
   * group fills one of its slots.
   *
   * Beside `style` rather than inside it, and absent rather than a full-column
   * rect when there is no wall: `App.tsx` reads the absence as "keep
   * `inset-0`", which is the one thing a hidden group must never stop doing. A
   * hidden group that shrank would be measured at its shrunken size by the
   * next fit that reached it (`Terminal.tsx:688`).
   */
  rect?: CellRect
  /** In `kids` order, and never empty. */
  panes: PaneBox[]
}

/**
 * Four places, so `1/3` lands on a stable string rather than
 * `33.33333333333333%`. What that rounding gives away is at most 0.0001% of
 * the tab — a thousandth of a pixel on any window this app can be opened at.
 */
function percent(share: number): string {
  return `${Number((share * 100).toFixed(4))}%`
}

/**
 * The panes of `row`, in `kids` order, each with its share of the axis.
 *
 * The share is read from `ratio` at the *kid's* index rather than at the
 * pane's position among the panes that exist, so a kid whose pane has not
 * arrived cannot slide every later pane onto the wrong share. Those absent
 * kids' shares are then dropped and what is left renormalised, so the panes
 * that are here fill the tab instead of leaving a hole where the missing one
 * would have gone.
 *
 * A kid already boxed is dropped the same way, whether it was boxed by an
 * earlier group (`claimed`) or by an earlier position in this very row — hence
 * `boxed`, which starts from `claimed` and grows as the row is walked, since
 * `claimed` itself is not written until this returns. Neither duplicate is a
 * state main hands over today: `tabRows` in store.ts dedupes kids across rows,
 * and `normaliseLayout` dedupes them within one. Both are states a *transient*
 * row rewrite could produce, and the consequence is severe out of all
 * proportion to a set membership test — the pane would be boxed twice,
 * mounting two xterms against one tmux pane, each fitting the session to its
 * own container, and in the same-row case handing both boxes one React key.
 * One pane, one box, however many times it is named.
 *
 * A kid outside `region` is dropped here as well, and its share renormalised
 * away with the absent kids'. The row is the unit main and restore write, and
 * nothing stops one naming panes of both regions: `tabs` is keyed by tab, and
 * region is a property of each pane in it. Without this test such a row would
 * put every one of its kids in both columns, which is the two-boxes-per-pane
 * case the paragraph above rules out within a single call and cannot see
 * across the two calls `App` makes.
 */
function boxesOfRow(
  state: WorkspaceState,
  row: TabRow,
  claimed: Set<string>,
  region: Region,
): PaneBox[] {
  const byId = new Map(state.panes.map((pane) => [pane.id, pane]))
  const boxed = new Set(claimed)
  const kept = row.layout.kids
    .map((id, index) => {
      const found = boxed.has(id) ? undefined : byId.get(id)
      const pane = found && regionOf(found) === region ? found : undefined
      if (pane) boxed.add(id)
      return { pane, share: row.layout.ratio[index] ?? 0 }
    })
    .filter((entry): entry is { pane: TabDescriptor; share: number } => entry.pane !== undefined)
  const total = kept.reduce((sum, entry) => sum + entry.share, 0)
  // A row carrying no usable ratios still has to divide the tab somehow, and
  // an even split is the only division that needs no data. Zero shares would
  // otherwise hand a pane a 0%-wide box, which fits to tmux's floor of 2×1 —
  // the geometry defect wearing different numbers.
  // A dead kid is kept, ratio and all, exactly like a live one — see `PaneBox.dead`
  // and the note on `paneGroups` about why this is the opposite of restore's rule.
  return kept.map((entry) => {
    const share = total > 0 ? entry.share / total : 1 / kept.length
    return {
      pane: entry.pane,
      share,
      style: { flexBasis: percent(share) },
      dead: isDead(state, entry.pane),
    }
  })
}

/**
 * Whether this pane's session has died, which an editor pane's never can.
 *
 * One function for both of `paneGroups`'s branches. The kind test is not
 * defensive tidying: `state.dead` is keyed by pane id and written by `died`,
 * off main's exit event, and an id collision or a config row carrying a
 * tombstone from before a pane was an editor puts an entry there for a pane
 * that has nothing to exit. `DeadPane` is gated on this, so a wrong answer
 * draws a Restart button over a file, and pressing it asks main to restart a
 * session that never existed.
 */
function isDead(state: WorkspaceState, pane: TabDescriptor): boolean {
  return canHaveSession(pane) && state.dead[pane.id] !== undefined
}

/** The wall as `paneGroups` needs to read it: slot order, and cells per row. */
export interface WallView {
  /** Independently configurable cells, in slot order. */
  slots: readonly { id: string; projectId: string; pin?: string | null }[]
  columns: number
}

/**
 * Which pane a project's wall cell should show: the pane it is following,
 * when follow-active is on, or its pin otherwise.
 *
 * One function for `visibleGroupIds` below and for `App.tsx`'s own read of
 * the pin, which draws the cell's header and its empty-cell placeholder from
 * the same answer. Two copies of this rule is how a follow-active cell would
 * come to show one pane in its terminal and a different one, or none, in its
 * header.
 *
 * A null `activeTabId` answers null rather than falling back to the pin:
 * the whole point of the flag is that the slot tracks whatever is active
 * now, and a project between panes is a project with nothing active, not a
 * reason to show what it last had pinned.
 */
export function wallPinFor(
  project: ProjectDescriptor,
  slot?: { pin?: string | null },
): string | null {
  if (project.wallFollowActive === true) return project.activeTabId
  return slot?.pin === undefined ? (project.wallPin ?? null) : slot.pin
}

/**
 * Which groups are on screen, in the order they are drawn.
 *
 * One entry without a wall, which is what this returned before wall mode and
 * why the normal branch is written as the one-element case rather than as a
 * branch beside it. With a wall, one entry per FILLED slot: a slot whose
 * project has no pin, or whose pin names a pane that is gone, contributes
 * nothing here and is drawn as an empty cell by the renderer instead.
 *
 * **Each entry carries the index of its SLOT, not its position among the
 * filled ones**, and the difference is the whole of what an empty cell is. A
 * wall of three slots with the middle one unpinned is three cells, the middle
 * one empty: the renderer draws a header and a placeholder there, which is the
 * only route from "this project is on the wall" to "this project shows a pane".
 * Numbering by filled slots instead would give that project no box to draw in,
 * and would resize every surviving cell (fitting tmux sessions nobody touched)
 * each time one pin came or went.
 *
 * The active id is resolved through `tabOfPane` in both branches because it may
 * name a pane rather than a tab: the tab bar lists panes, and a pin names a
 * pane, so neither is an id a row is necessarily keyed by. Showing that pane's
 * tab is what the user asked for; matching group ids alone would show nothing.
 */
function visibleGroupIds(
  state: WorkspaceState,
  region: Region,
  wall: WallView | null,
): { id: string; slot: number }[] {
  if (wall === null || region !== 'terminal') {
    const id = activeTabId(state, region)
    if (id === null) return []
    return [{ id: tabOfPane(state, id)?.id ?? id, slot: 0 }]
  }
  const filled: { id: string; slot: number }[] = []
  for (const [slot, wallSlot] of wall.slots.entries()) {
    const project = state.projects.find((entry) => entry.id === wallSlot.projectId)
    if (project === undefined) continue
    const pin = wallPinFor(project, wallSlot)
    if (pin === null) continue
    const pane = state.panes.find((entry) => entry.id === pin)
    if (pane === undefined || regionOf(pane) !== 'terminal') continue
    const id = tabOfPane(state, pin)?.id ?? pin
    // Two slots pinned to panes of the same tab would otherwise ask for one
    // group in two places, and a group has one box. The earlier slot keeps it,
    // and the later one is left to the renderer as an empty cell, which is
    // wrong about that cell's pin but right about its geometry, and no state
    // the app can reach today produces it: `slotsFromStored` gives a project
    // one slot, and a tab belongs to one project.
    if (!filled.some((entry) => entry.id === id)) filled.push({ id, slot })
  }
  return filled
}

/**
 * Every pane in `region`, arranged: one group per tab, in the order the
 * tabs' first panes appear in `state.panes`.
 *
 * **At most one box per pane is enforced here**, by `claimed` across rows and
 * by `boxed` within one — no input can make this mount two xterms on one tmux
 * pane. **At least one box per pane is NOT enforced here**, and saying so is
 * the point: this function skips any group id it has already seen, so it is
 * only ever as good as the ids it is given. It needs unique row ids *and* it
 * needs no stray pane to carry an id a row is keyed by; the second was assumed
 * rather than argued until a dead founder pane produced exactly that and cost
 * a tab every live terminal in it. `withKeptPanes` is what supplies it now.
 * The row-id half is inherited from the two writers of
 * `tabs`: `restore.ts` builds its rows from a Map keyed by tab id and
 * replaces `tabs` wholesale, and `register.ts`'s `withTabRow` replaces the row
 * at a matching id or appends — neither can mint a second row with an id it
 * already has. Not from `store.ts`: its `tabRows` takes `candidate.id` as it
 * finds it, and the set it shrinks dedupes *kids*, not row ids, so two rows
 * sharing an id with disjoint kids survive a `read()` intact. Given unique row
 * ids, a pane whose group is already built was either boxed by the row that
 * built it or claimed by an earlier one, so it is somewhere. Without them the
 * second row is skipped by `seen` and its panes are dropped, which is a pane
 * that never mounts. That case is not defended against because there is no
 * non-arbitrary way to choose between two rows claiming to be the same tab; it
 * is named so the next person does not have to rediscover which half of this
 * is a guarantee and where the other half comes from.
 *
 * Driven by `state.panes` rather than by `state.tabs` for two reasons. Every
 * pane in `region` gets a group whether or not a row names it (nothing here
 * can drop a terminal), and a pane's position among the groups does not move
 * when a row arrives for it, so nothing is reordered in the DOM either.
 *
 * **A dead pane is boxed like any other**, keeping its slot and its share, and
 * carries `dead` so the renderer can offer Restart and Dismiss over it. That is
 * the opposite of what `restoreWorkspace` does with a pane whose session is
 * gone, and both are right for their own moment. Restore prunes: it skips every
 * saved pane live tmux does not have (`byId.get(row.id)` misses, `continue`) and
 * so never hands that pane to `tabRowFor`, because at launch such a pane has no
 * window, no xterm and no scrollback — there is nothing to draw and nowhere to
 * draw it, and reopening one would put a fresh shell outside the tab's group.
 * A pane that died while this window was up still has all three, and its
 * scrollback is the only record of why it died. Collapsing it would throw that
 * away at the exact moment it is wanted — the same mistake that once made
 * `crashed` a state nothing could render (see the `died` case below).
 */
export function paneGroups(
  state: WorkspaceState,
  region: Region = 'terminal',
  wall: WallView | null = null,
): PaneGroup[] {
  const visible = visibleGroupIds(state, region, wall)
  // Index into the wall, not into `groups`: `groups` is built in `state.panes`
  // order, and a cell's place on screen is its SLOT's place.
  const slotOf = new Map(visible.map((entry) => [entry.id, entry.slot]))
  const groups: PaneGroup[] = []
  const seen = new Set<string>()
  const claimed = new Set<string>()
  for (const pane of state.panes) {
    if (regionOf(pane) !== region) continue
    const row = tabOfPane(state, pane.id)
    const id = row?.id ?? pane.id
    if (seen.has(id)) continue
    seen.add(id)
    // This branch cannot be handed a pane that is already boxed, though not
    // because of what `claimed` holds — a stray's own id goes in there too,
    // on the line below. It is the dichotomy: a pane that entered `claimed`
    // from a row is in that row's `kids`, so `tabOfPane` would have found the
    // row and sent it down the other branch; and a stray that has been here
    // once has its own id in `seen`, which is what was just checked.
    const panes = row
      ? boxesOfRow(state, row, claimed, region)
      : [{ pane, share: 1, style: { flexBasis: '100%' }, dead: isDead(state, pane) }]
    // Only reachable from the same double-naming this guards: a row whose
    // kids were all boxed by rows processed before it has nothing left to
    // show, and an empty container is not a tab, it is a blank screen where
    // the panes are already visible elsewhere.
    if (panes.length === 0) continue
    for (const box of panes) claimed.add(box.pane.id)
    const slot = slotOf.get(id)
    groups.push({
      id,
      visible: slot !== undefined,
      // A one-pane tab has a row and therefore a `dir`, set by whichever split
      // created the tab it came from. That is an axis with nothing to divide,
      // not a claim that this tab is split.
      style: { flexDirection: row?.layout.dir === 'col' ? 'column' : 'row' },
      // Only when there is a wall AND this is the terminal column: wall mode is
      // terminal-region only, and `visibleGroupIds` already refuses to route a
      // browser id through the wall branch, but that refusal lives in HOW
      // `visible` is built, and a `slot` found here says nothing about which
      // region put it there. Repeating the region test at the one place a rect
      // is actually handed out means a caller that mistakenly passes a wall
      // into a browser-region call still cannot make this column resize with
      // it, rather than relying on every future caller keeping that promise.
      // The grid is sized by the SLOTS, not by the filled ones, for the reason
      // `visibleGroupIds` gives. `wall.slots` is expected to name projects that
      // exist (`slotsFromStored` resolves it against the live list before it
      // gets here), so a cell counted here is a cell the renderer draws.
      ...(wall !== null && region === 'terminal' && slot !== undefined
        ? { rect: cellRect(slot, wall.slots.length, wall.columns) }
        : {}),
      panes,
    })
  }
  return groups
}

/**
 * `next`, with any kid of the row it replaces that is still a pane here but
 * that main did not name, put back where it was.
 *
 * This is the seam between two rules that are each right on their own. Main
 * owns existence and forgets a pane the moment its session dies — `forgetTab`
 * drops its row, and `normaliseLayout` then drops it from the tab's kids — so
 * a `TabShape` reply names only panes that are on disk. The renderer owns
 * tombstones: a pane that died while this window was up keeps its box, its
 * share and its scrollback until the user restarts or dismisses it. Taking
 * main's `kids` wholesale therefore threw every tombstone out of its tab on
 * the next split or close, which is the one transition that rule was never
 * tested over.
 *
 * Three things went wrong when it did, and the first is why this is not a
 * cosmetic merge. A tab row's id IS its founder pane's id, so a tab whose
 * FOUNDER is the tombstone produced a stray pane keyed by the very id its own
 * row is keyed by — and `paneGroups` skips a group id it has already seen, so
 * **every live pane of that tab lost its box**, unmounting its xterm and
 * destroying the scrollback. Second, the tombstone's own state stopped
 * reaching `stateOfTab`, so a crashed pane's tab and project both went green
 * while the tab bar still drew that pane red. Third, its share was
 * redistributed to its siblings, which is the collapse the dead-pane ruling
 * exists to prevent.
 *
 * Only a kid that is still in `panes` comes back. The pane just closed is
 * already out of that list by the time this runs, so a close cannot resurrect
 * what it removed — and only a kid the PRIOR ROW itself held is considered, so
 * a pane that never belonged to this tab cannot be swept into it.
 *
 * **A reinserted kid keeps its own share exactly, and the incoming row is
 * scaled into the room that is left** — not renormalised alongside it. The
 * difference is the ruling: renormalising treats every share alike, so a
 * tombstone at half a tab came back at a third of one the moment its sibling
 * was split, which is the dead pane resizing. Scaling instead means the panes
 * main sized divide `1 - (what the tombstones hold)` between them in the
 * proportions main asked for, the tombstone is untouched, and the row still
 * sums to a whole tab.
 *
 * Falls back to an even split when the kept shares leave no room, or when the
 * incoming row's own shares sum to nothing.
 *
 * **`store.read()` is not what makes that unreachable, and citing it would be
 * citing a file this never sees.** Neither row here has been through it:
 * `prior` is renderer state — a previous reply, possibly already re-merged by
 * this very function — and `next` is main's reply, written either by
 * `splitPane`, which reaches `store.read()` only for the row it carves FROM,
 * or by `tabRowFor`, where it is two hops away. What
 * actually keeps every share positive is those two writers plus this
 * function's own output, which is positive in both branches — an invariant
 * that is partly self-referential, and worth saying so rather than borrowing
 * someone else's guarantee.
 *
 * Given positive shares, `held === 1` needs every kid of `prior` to be
 * missing. On the close path that is **structural**: `priorRow` is found by
 * `kids.includes(paneId)`, so the closed pane is always in `prior.kids`, and
 * it is filtered out of `panes` before this runs, so it can never be in
 * `missing` — `missing` is a strict subset and `held < 1`. On the split path
 * the same argument needs the split pane to be in `prior.kids`, which holds
 * only because a founder can no longer fall out of its own row; nothing
 * asserts it, so the branch stays.
 *
 * **Its own cost, which is not free and is the reason it is a last resort:**
 * an even split RESIZES EVERY TOMBSTONE — measured, two dead panes at half a
 * tab each come back at a third — which is exactly the symptom the paragraph
 * above rejects renormalising for. It is taken anyway only because the
 * alternative is worse: a zero share is a 0%-wide box, which fits to tmux's
 * 2x1 floor, and that is the geometry defect wearing different numbers.
 */
function withKeptPanes(
  prior: TabRow | undefined,
  next: TabRow,
  panes: TabDescriptor[],
): TabRow {
  if (!prior) return next
  const present = new Set(panes.map((pane) => pane.id))
  const named = new Set(next.layout.kids)
  const missing = prior.layout.kids
    .map((id, index) => ({ id, index, share: prior.layout.ratio[index] ?? 0 }))
    .filter((entry) => present.has(entry.id) && !named.has(entry.id))
  if (missing.length === 0) return next

  const held = missing.reduce((sum, entry) => sum + entry.share, 0)
  const incoming = next.layout.ratio.reduce((sum, share) => sum + share, 0)
  const room = 1 - held
  const usable = room > 0 && incoming > 0

  const entries = next.layout.kids.map((id, index) => ({
    id,
    share: usable ? ((next.layout.ratio[index] ?? 0) / incoming) * room : 0,
  }))
  // Put back in front of the kid that followed it, NOT at the index it held.
  //
  // The two are not interchangeable and cannot both be satisfied: main inserts
  // a new pane directly after the sibling it was split from — deliberately, and
  // `persistence.test.ts` has a dedicated test for it — so restoring a
  // tombstone to its old absolute index pushes the new pane away from the pane
  // the user split. Measured: `[aaa, bbb(dead), ccc]` split at `aaa` gave
  // `[aaa, bbb, new, ccc]`, with a dead pane sitting between the two halves of
  // the split that had just been asked for.
  //
  // Anchoring on the successor satisfies both. The tombstone keeps its position
  // relative to the panes it was among, and main's insertion point survives
  // intact: the same case gives `[aaa, new, bbb, ccc]`.
  //
  // The first surviving successor, not simply the next id, so a run of adjacent
  // tombstones lands in its original order — each one anchors on the one after
  // it once that has been placed. A tombstone that was last in `prior` has no
  // successor and goes to the end.
  for (const entry of missing) {
    const after = prior.layout.kids.slice(entry.index + 1)
    const at = entries.findIndex((candidate) => after.includes(candidate.id))
    entries.splice(at === -1 ? entries.length : at, 0, { id: entry.id, share: entry.share })
  }
  return {
    ...next,
    layout: {
      ...next.layout,
      kids: entries.map((entry) => entry.id),
      ratio: entries.map((entry) => (usable ? entry.share : 1 / entries.length)),
    },
  }
}

/**
 * Folds a `TabShape` reply into state: every pane it names is upserted into
 * `state.panes` in place, with any pane not already present appended, and its
 * one row — when it has one — replaces the matching entry in `state.tabs` or
 * is appended if this tab had none yet.
 *
 * The row that replaces keeps this tab's tombstones, which main cannot name;
 * see `withKeptPanes`.
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
  const incoming = shape.tabs[0]
  const row = incoming
    ? withKeptPanes(
        state.tabs.find((candidate) => candidate.id === incoming.id),
        incoming,
        panes,
      )
    : undefined
  const tabs = row
    ? state.tabs.some((candidate) => candidate.id === row.id)
      ? state.tabs.map((candidate) => (candidate.id === row.id ? row : candidate))
      : [...state.tabs, row]
    : state.tabs
  return { ...state, panes, tabs }
}

/**
 * Folds a `JoinShape` reply into state: every pane it names is upserted into
 * `state.panes`, exactly as `applyTabShape` does, and each row it names
 * either replaces the matching entry in `state.tabs` or is appended. Unlike
 * `applyTabShape`, this can also SUBTRACT a row: `shape.dropped`, when set,
 * names the source tab whose last pane the join took, and that row is
 * removed rather than left stale.
 *
 * Not built on `applyTabShape`: that helper's own doc comment says it
 * deliberately never subtracts, because `closedPane` needed the same
 * upsert-only behaviour and bending one signature to answer both "replace or
 * insert" and "replace, insert or remove" would make it answer two different
 * questions. A join needs both parts every time it runs, so this is its own
 * short block instead of a flag threaded through the other one.
 *
 * Each incoming row goes through `withKeptPanes`, same as `applyTabShape`,
 * so a tombstone this window is holding for either tab survives the join.
 *
 * `shape.tabs[0]` is read as the target row's `activePaneId` to select it.
 * That ordering is a convention of the reply, not something this function
 * enforces: the target is placed first by the code that builds `shape`, and
 * a producer-side test pins it there.
 */
function applyJoinShape(state: WorkspaceState, shape: JoinShape): WorkspaceState {
  const panes = [
    ...state.panes.map((pane) => shape.panes.find((incoming) => incoming.id === pane.id) ?? pane),
    ...shape.panes.filter((incoming) => !state.panes.some((pane) => pane.id === incoming.id)),
  ]

  let tabs = state.tabs.filter((row) => row.id !== shape.dropped)
  for (const incoming of shape.tabs) {
    const row = withKeptPanes(
      tabs.find((candidate) => candidate.id === incoming.id),
      incoming,
      panes,
    )
    tabs = tabs.some((candidate) => candidate.id === row.id)
      ? tabs.map((candidate) => (candidate.id === row.id ? row : candidate))
      : [...tabs, row]
  }

  const next = { ...state, panes, tabs }
  const joined = shape.tabs[0]?.activePaneId
  const pane = joined ? panes.find((candidate) => candidate.id === joined) : undefined
  return pane ? setActiveTab(next, projectIdForTab(next.projects, pane), pane.id) : next
}

function setActiveTab(
  state: WorkspaceState,
  projectId: string,
  activeTabId: string | null,
  region: Region = 'terminal',
): WorkspaceState {
  return {
    ...state,
    projects: state.projects.map((project) =>
      project.id !== projectId ? project : { ...project, [SELECTION_FIELD[region]]: activeTabId },
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
  const region = regionOf(tab)
  // Only the owning project's selection moves; every other project keeps
  // whichever tab it was on.
  //
  // Grouped, not the raw `tabsOfProject` filter: `neighbourOf` picks by
  // position, and a split's sibling sits elsewhere in `state.panes` than it
  // does in the bar (see `neighbourOf`'s own doc comment). Scoped to `id`'s
  // own region, same as `closedPane`: an unfiltered list can hand a
  // dismissed terminal's neighbour to a browser pane.
  const siblings = groupedTabs(tabsOfProject(state, owner, region), state.tabs).map(
    (entry) => entry.pane,
  )
  const selected = selectionOf(
    state.projects.find((candidate) => candidate.id === owner),
    region,
  )
  const nextActive = selected === id ? neighbourOf(siblings, id) : selected
  return setActiveTab(
    { ...state, panes: state.panes.filter((candidate) => candidate.id !== id) },
    owner,
    nextActive,
    region,
  )
}

/**
 * `panes`, with `agentSessionId` cleared on any browser pane whose session
 * pane is no longer among them.
 *
 * Referential rather than tied to one action, because a session pane leaves
 * `state.panes` through `'removed'`, `'dismissed'` and `'closedPane'` alike
 * (see each case in `workspaceReducer`, below), and a browser pane's flag is
 * stale the moment the pane it names is gone through any of the three, not
 * only the one this function happens to be called from.
 *
 * Never drops a pane, only the field: the browser pane a closed or dismissed
 * agent session owned stays on screen, confined but unowned, which is the
 * survival half of the rule this exists for. Main does the matching thing on
 * its own copy of the pane list, over its own runtime-only record of the
 * association (`agentSessions` in `main/ipc/register.ts`): this is the
 * renderer's mirror of that, not a second source of truth for it. Main is
 * still what a relaunch reattaches from, and this map is empty again at
 * every launch exactly as main's is.
 */
function withAgentSessionsCleared(panes: TabDescriptor[]): TabDescriptor[] {
  const alive = new Set(panes.map((pane) => pane.id))
  return panes.map((pane) =>
    pane.agentSessionId !== undefined && !alive.has(pane.agentSessionId)
      ? { ...pane, agentSessionId: undefined }
      : pane,
  )
}

/**
 * Every row with `id` taken out of its kids, and what is left renormalised.
 *
 * Called from exactly the two actions that take a pane out of `state.panes` —
 * `dismissed` and `removed` — and **never from `died`.** That distinction is
 * the whole safety argument. A pane dropped from `kids` while it is still in
 * `state.panes` is a stray, `paneGroups` keys a stray by its own id, and a
 * dead FOUNDER's id is its row's id: the two collide in `seen`, and whichever
 * is walked second is skipped, unmounting every live terminal in the tab. A
 * dismissed pane leaves `state.panes` in this same reducer step, so there is
 * no stray to collide with — even for a founder, whose row keeps its id.
 *
 * Renormalised rather than left with a hole: `boxesOfRow` already divides the
 * survivors' shares by their own total for the screen, so a row summing to
 * less than 1 would make `state.tabs` disagree with what is drawn — and
 * `commitLayout` sends this row to main as whole-tab fractions. This is the
 * same projection `sharesAroundClaims` and `boxesOfRow` do, not a rescale
 * covering a gap: the pane is gone, and the survivors divide the tab.
 *
 * A row that keeps no kid at all is left alone rather than emptied, and that
 * state is REACHED rather than hypothetical. Dismissing a tab's panes one
 * after another arrives here with one kid left; `closedPane`, which would
 * otherwise have dropped the row, never runs for an all-dead tab, because ⌘W
 * on a dead pane rejects inside `manager.kill` and dispatches nothing at all
 * (see `App.tsx`'s `closePane`). Measured through this reducer: `died a`,
 * `died b`, `dismissed b`, `dismissed a` leaves `panes: []` and
 * `tabs: [{ id: 'a', kids: ['a'] }]` — a row naming a pane that no longer
 * exists.
 *
 * The guard is right anyway, and that is why it is left as it is: `paneGroups`
 * walks `state.panes`, so a kid with no pane of its own draws nothing, and an
 * empty row would be a container with nothing in it, which `paneGroups` drops
 * regardless. Both spellings are invisible; leaving the row whole is the one
 * that touches nothing.
 */
function withoutKid(state: WorkspaceState, id: string): WorkspaceState {
  const row = state.tabs.find((candidate) => candidate.layout.kids.includes(id))
  if (!row) return state
  const kept = row.layout.kids
    .map((kid, index) => ({ kid, share: row.layout.ratio[index] ?? 0 }))
    .filter((entry) => entry.kid !== id)
  if (kept.length === 0) return state
  const total = kept.reduce((sum, entry) => sum + entry.share, 0)
  const next: TabRow = {
    ...row,
    layout: {
      ...row.layout,
      kids: kept.map((entry) => entry.kid),
      ratio: kept.map((entry) => (total > 0 ? entry.share / total : 1 / kept.length)),
    },
  }
  return { ...state, tabs: state.tabs.map((candidate) => (candidate.id === row.id ? next : candidate)) }
}

/**
 * What the welcome page's last line says.
 *
 * The sentence form of `canOpenSession`, naming whichever of its three parts
 * is missing. One predicate, two renderings: a hint that disagreed with
 * whether Cmd+T works would be worse than no hint, which is why both this and
 * `App.tsx`'s `launch` read the same function rather than each keeping their
 * own copy of the test.
 *
 * Here rather than in `Welcome.tsx` so it can be exercised against a
 * `WorkspaceState` with no DOM, which is how every other derivation in this
 * file is tested.
 */
export function welcomeHint(state: WorkspaceState): string {
  // Before the no-active-project case below, which would otherwise claim a
  // first launch too: with no projects there is no active project either.
  if (state.projects.length === 0) return 'select a working directory to start'
  const project = activeProject(state)
  // Unsorted shares this line because it is not a directory and cannot launch;
  // the move out of it is the same move, pick a real project.
  if (!project || project.id === UNSORTED_ID) return 'select a project to start'
  // Reached only once a project is active and is not Unsorted, so this is
  // exactly `canOpenSession`'s third part, `!project.available`.
  if (!canOpenSession(state)) return `${project.cwd} is missing`
  return 'press Cmd+T to start a session'
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
        since: state.since,
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
        regionOf(action.tab),
      )
    }

    case 'activatedTab': {
      const tab = state.panes.find((candidate) => candidate.id === action.id)
      if (!tab) return state
      return setActiveTab(state, projectIdForTab(state.projects, tab), action.id, regionOf(tab))
    }

    case 'activatedProject': {
      if (!state.projects.some((project) => project.id === action.id)) return state
      return { ...state, activeProjectId: action.id }
    }

    case 'removed': {
      const { [action.id]: _dropped, ...status } = state.status
      const { [action.id]: _tombstone, ...dead } = state.dead
      const next = withoutKid(removeTab(state, action.id), action.id)
      return { ...next, panes: withAgentSessionsCleared(next.panes), status, dead }
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

    case 'panesMerged': {
      // Merged by id, like `movedTab`, rather than replacing `state.panes`
      // outright: whatever reason a reply has for being silent about some
      // pane, that pane must keep the entry it already had rather than
      // vanish from the bar. Defence in depth for the reducer itself, not a
      // response to a specific gap in what any one caller sends today.
      //
      // Named for what it does rather than for who calls it. Renaming and
      // recolouring both reply with the whole pane list and both want exactly
      // this merge, and a `recoloredPane` case with a body identical to a
      // `renamedTab` one is two rules that can drift, which is the mistake
      // the tab label made before `tabLabel` was one function.
      const named = new Map(action.panes.map((pane) => [pane.id, pane]))
      return {
        ...state,
        panes: state.panes.map((pane) => {
          const incoming = named.get(pane.id)
          if (!incoming) return pane
          // The one field a reply of this shape cannot carry, kept from the
          // record it is replacing. Both callers answer with `config.panes`,
          // and `normalisePane` (`main/state/store.ts`) strips
          // `agentSessionId` off every row `store.read()` returns, so a reply
          // built from disk says "owned by nobody" about every pane in the
          // window. Replaced wholesale, that silence cleared the flag on every
          // agent-owned browser pane in the app, and `BrowserPane` stopped
          // drawing the strip over a pane that was still owned, still confined
          // and still the agent's: renaming any tab anywhere was enough. See
          // the regression test in `tests/e2e/browserMcp.spec.ts`, which failed
          // exactly this way before this branch.
          //
          // This is the same rule the merge above it already follows, one level
          // down: a reply that is silent about something does not get to
          // destroy it. Ownership is never ANNOUNCED by a reply either, so
          // there is no case where the incoming record is the authority and
          // this would be holding a stale flag: it is set by
          // `browserPaneOpened` and cleared by `withAgentSessionsCleared` in
          // each of the three reducer cases that take a pane out of
          // `state.panes` for good, which is the count its own doc gives.
          return incoming.agentSessionId === undefined && pane.agentSessionId !== undefined
            ? { ...incoming, agentSessionId: pane.agentSessionId }
            : incoming
        }),
      }
    }

    case 'statusSnapshot':
      return { ...state, status: action.status, since: action.since ?? state.since }

    case 'statusChanged': {
      // Null means the pane was forgotten — dismissed, or killed on purpose —
      // not a seventh state to draw. Storing it as a value would let it slip
      // into the fold behind every dot above a pane (`stateOfTab` filters the
      // statuses it reads on `undefined`, not on `null`) and it would sit in
      // `state.status` forever, since nothing else ever removes a key once
      // `statusChanged` has written it.
      if (action.state === null) {
        const { [action.tabId]: _dropped, ...status } = state.status
        // The clock goes with it, for the reason above: nothing else removes a
        // key once written, so a forgotten tab would keep a `since` forever and
        // hand it to whatever id happened to reuse the slot.
        const { [action.tabId]: _forgotten, ...since } = state.since
        return { ...state, status, since }
      }
      return {
        ...state,
        status: { ...state.status, [action.tabId]: action.state },
        since:
          action.since === null || action.since === undefined
            ? state.since
            : { ...state.since, [action.tabId]: action.since },
      }
    }

    case 'died':
      // Deliberately keeps the tab, and keeps it selected. Its scrollback is
      // the only record of why it died, and dropping it is what made `crashed`
      // a state nothing could ever render.
      return { ...state, dead: { ...state.dead, [action.id]: action.code } }

    case 'dismissed': {
      const { [action.id]: _dropped, ...dead } = state.dead
      // Same selection move a close makes, so dismissing the tab you are
      // looking at does not leave the pane showing nothing — and the tab's row
      // stops naming a pane that is no longer there, which is what kept every
      // divider in that tab from being grabbable (see `withoutKid`).
      const next = withoutKid(removeTab(state, action.id), action.id)
      return { ...next, panes: withAgentSessionsCleared(next.panes), dead }
    }

    case 'split':
      return applyTabShape(state, action.shape)

    case 'joined':
      return applyJoinShape(state, action.shape)

    case 'closedPane': {
      // The row from before the close, found by its old `kids` — `shape`
      // alone cannot tell us which pane just left, since closing a tab's last
      // pane hands back an empty `panes` and an empty `tabs` with nothing in
      // either to name it.
      const priorRow = state.tabs.find((row) => row.layout.kids.includes(action.paneId))
      // Read before the filter below drops it: the selection rule needs to
      // know which project owned the pane, and a pane's project lives in its
      // own record.
      const closed = state.panes.find((pane) => pane.id === action.paneId)
      const panes = withAgentSessionsCleared(state.panes.filter((pane) => pane.id !== action.paneId))
      const nextRow = action.shape.tabs[0]
      // Keeping this tab's tombstones, which main forgot at their panes' death
      // and cannot name here — see `withKeptPanes`. Against `panes`, which has
      // already had the closed pane filtered out of it, so the close cannot put
      // back what it just removed.
      const merged = nextRow ? withKeptPanes(priorRow, nextRow, panes) : undefined
      const tabs = priorRow
        ? merged
          ? // Row ids are frozen to the founder pane, so `nextRow.id` is always
            // `priorRow.id` here — never a rename to chase.
            state.tabs.map((row) => (row.id === priorRow.id ? merged : row))
          : // A tab whose last LIVE pane has gone loses its row, tombstones and
            // all. Each becomes a group of its own, keyed by its own id — no
            // longer a collision, because the row that shared that id has gone
            // with it — so its scrollback stays mounted and stays reachable from
            // its own tab-bar entry.
            state.tabs.filter((row) => row.id !== priorRow.id)
        : state.tabs
      const next = { ...state, panes, tabs }

      // The selection names a pane, and the pane it names has just gone. Left
      // alone it points at nothing: `visibleGroupId` resolves it through
      // `tabOfPane`, finds no row and no group keyed by it, and the window
      // shows no terminal at all — as well as leaving the keyboard acting on a
      // pane that is not there.
      //
      // Only the closed pane's own region moves, in the project that owned
      // it, exactly as `removeTab` does it: every other project keeps
      // whatever it was on, and this project's other region keeps its own
      // selection too.
      if (!closed) return next
      const region = regionOf(closed)
      const owner = projectIdForTab(state.projects, closed)
      const selected = selectionOf(
        state.projects.find((candidate) => candidate.id === owner),
        region,
      )
      if (selected !== action.paneId) return next
      // Main's own answer first — `closePane` names the survivor that takes
      // over in the row it hands back — and the tab bar's neighbour rule when
      // there is no row left to name one, which is a tab that has closed
      // entirely. `neighbourOf` is asked over the GROUPED panes from BEFORE
      // the close, scoped to the closed pane's own region: for the terminal
      // region this is the same order `TabBar` draws from (`App.tsx`'s
      // `tabEntries`), since it finds the neighbour by the closed pane's own
      // place in that order, not its position in raw `state.panes`.
      return setActiveTab(
        next,
        owner,
        nextRow?.activePaneId ??
          neighbourOf(
            groupedTabs(tabsOfProject(state, owner, region), state.tabs).map((entry) => entry.pane),
            action.paneId,
          ),
        region,
      )
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

    case 'resized': {
      const row = state.tabs.find((candidate) => candidate.id === action.tabId)
      if (!row) return state
      // A gesture that raced a split or a close carries a ratio for a row that
      // no longer has that many kids. Pairing them by position would mis-size
      // every pane in the tab, and the drag's own next frame corrects it — so
      // dropping the stale frame costs nothing and guessing costs the layout.
      if (action.ratio.length !== row.layout.kids.length) return state
      return {
        ...state,
        tabs: state.tabs.map((candidate) =>
          candidate.id === action.tabId
            ? { ...candidate, layout: { ...candidate.layout, ratio: action.ratio } }
            : candidate,
        ),
      }
    }
  }
}
