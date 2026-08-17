import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { Terminal, paneGrid, focusTerminal } from './Terminal'
import { HistoryOverlay } from './HistoryOverlay'
import { PaneDivider } from './PaneDivider'
import { TabBar } from './TabBar'
import { TabsPanel } from './TabsPanel'
import { DeadPane } from './DeadPane'
import { Sidebar } from './Sidebar'
import { FilesPanel } from './FilesPanel'
import { SkillsPanel } from './SkillsPanel'
import { PresetsPanel } from './PresetsPanel'
import { PromptsPanel } from './PromptsPanel'
import { GitPanel } from './GitPanel'
import { IssuesPanel } from './IssuesPanel'
import { TodosPanel } from './TodosPanel'
import { NotesPanel } from './NotesPanel'
import { BrowserColumn } from './BrowserColumn'
import { WallCell } from './WallCell'
import { AddProjectDialog } from './AddProjectDialog'
import { ConfirmClosePane } from './ConfirmClosePane'
import { SettingsPane } from './settings/SettingsPane'
import { TitleBar } from './TitleBar'
import { UpdateBar } from './UpdateBar'
import { HooksBar } from './HooksBar'
import { StatusBar } from './StatusBar'
import { Welcome } from './Welcome'
import { CommandPalette, type PaletteSession } from './CommandPalette'
import { FileView, saveEditorPane } from './FileView'
import { clearTerminal, selectionOf } from './Terminal'
import { opensInEditor } from './lib/terminalPaths'
import { DiffView } from './DiffView'
import { cn } from './lib/cn'
import { tabLabel } from './lib/tabLabel'
import { relativeToProject } from './lib/relativeToProject'
import { markDirty, forgetPane, type DirtyPanes } from './lib/dirtyPanes'
import {
  COLUMN_IDS,
  anyOpen,
  hideAll,
  restore,
  showsTabBar,
  type ColumnId,
  type ColumnVisibility,
} from './lib/columnVisibility'
import { moveColumn, orderFromStored, resizerSideFor, type ColumnSlot } from './lib/columnOrder'
import { cellRect } from './lib/wallLayout'
import { columnsFromStored, slotsFromStored, toggleSlot } from './lib/wallSlots'
import {
  INITIAL_WORKSPACE_STATE,
  activeProject,
  activeTabId,
  canOpenSession,
  grabFor,
  needsYou,
  paneGroups,
  paneInDirection,
  projectIdForTab,
  resizeKids,
  stateOfProject,
  tabOfPane,
  tabsOfProject,
  wallPinFor,
  welcomeHint,
  workspaceReducer,
  type PaneBox,
  type PaneDirection,
  type PaneGroup,
} from './workspace'
import { groupedTabs, tabTree } from './lib/tabGroups'
import { projectMuted, toggleProjectMute } from './mute'
import { PANE_COLOR_DEFAULT, type PaneColor } from '../shared/paneColors'
import type { ThemeId } from '../shared/themes'
import { applyTheme, bootTheme } from './theme'
import { ColorSwatches } from './ColorSwatches'
import {
  UNSORTED_ID,
  regionOf,
  type DiffSide,
  type HistoryEntry,
  type HistoryScope,
  type NotificationConfig,
  type ProjectDescriptor,
  type Region,
  type TabDescriptor,
  type TabType,
  type UpdateInfo,
} from '../shared/ipc'
import { SEVERITY } from '../shared/status'

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

/**
 * Collapse state for the collapsible columns: '0' means expanded, anything
 * else (including absent) means collapsed.
 *
 * **Every one of them defaults collapsed**, so a fresh profile shows the
 * projects sidebar and the terminal and nothing else. Each expanded column
 * costs 208px by default, so the keys below plus the 208px sidebar already add
 * up to more than the 1280px window `src/main/index.ts` opens, and expanding
 * all of them on that window leaves no room for a terminal. Nothing stops a
 * user from doing it anyway on a wider or maximised window. The state persists
 * per column, so this default is the first run only.
 */
const SKILLS_KEY = 'pterm:skillsCollapsed'
const PRESETS_KEY = 'pterm:presetsCollapsed'
const FILES_KEY = 'pterm:filesCollapsed'
const PROMPTS_KEY = 'pterm:promptsCollapsed'
const GIT_KEY = 'pterm:gitCollapsed'
const ISSUES_KEY = 'pterm:issuesCollapsed'
const TODOS_KEY = 'pterm:todosCollapsed'
const NOTES_KEY = 'pterm:notesCollapsed'
const TABS_KEY = 'pterm:tabsCollapsed'
const BROWSER_KEY = 'pterm:browserCollapsed'

/** Where the row's left-to-right order is kept, once a drag has changed it. */
const ORDER_KEY = 'pterm:columnOrder'

/*
 * A column has THREE states, and these keys hold the second of the two flags.
 *
 * HIDDEN is the View menu's doing and renders nothing at all. COLLAPSED is the
 * heading's doing and renders the 24px strip, which is one click from open.
 * They were briefly the same thing, and setting a column aside then meant
 * losing the only way to bring it back without the menu.
 *
 * Separate keys rather than one tri-state value so a profile written by a
 * build that only knew `collapsed` still reads correctly: the hidden flags
 * simply default, and nothing has to migrate.
 */
const HIDDEN_KEYS: Record<ColumnId, string> = {
  tabs: 'pterm:tabsHidden',
  files: 'pterm:filesHidden',
  skills: 'pterm:skillsHidden',
  presets: 'pterm:presetsHidden',
  prompts: 'pterm:promptsHidden',
  git: 'pterm:gitHidden',
  issues: 'pterm:issuesHidden',
  todos: 'pterm:todosHidden',
  notes: 'pterm:notesHidden',
  browser: 'pterm:browserHidden',
}

/** Reads one of those keys, with the default applied when nothing is stored. */
function storedCollapsed(key: string, fallback: boolean): boolean {
  const stored = localStorage.getItem(key)
  if (stored === null) return fallback
  return stored !== '0'
}

/**
 * Whether a focused element sits inside the browser region.
 *
 * `BrowserColumn`'s root carries `data-region="browser"` for this, in all
 * three of its states, and the pane box is a child of that root even when the
 * column is put away. An attribute rather than the column's `data-testid`,
 * which is only written while the panel is open and is a test's handle rather
 * than a fact the app reads.
 */
function inBrowserRegion(node: Element | null): boolean {
  return node !== null && node.closest('[data-region="browser"]') !== null
}

/**
 * Whether the wall is on, which projects hold its slots, and how many cells go
 * in a row.
 *
 * In `localStorage` beside `ORDER_KEY` and the `*Collapsed` keys rather than in
 * the config, which is the split `wallSlots.ts` argues: these are facts about
 * how THIS window is arranged. Which PANE a project shows is a fact about the
 * project and lives in `ProjectRecord.wallPin` instead.
 */
const WALL_KEY = 'pterm:wall'
const WALL_SLOTS_KEY = 'pterm:wallSlots'
const WALL_COLUMNS_KEY = 'pterm:wallColumns'

/** What `useWallState` hands back. The setters are the routes Task 8 wires. */
interface WallState {
  on: boolean
  /** Project ids in slot order, resolved against the projects that exist. */
  slots: string[]
  columns: number
  setOn: (on: boolean) => void
  setColumns: (count: number) => void
  toggleSlot: (projectId: string) => void
}

/**
 * The three preferences above, read once and written back on every change the
 * user makes.
 *
 * A hook rather than three more `useState`s in `App`, which is long enough
 * already, and because the slot list needs a piece of care the other two do
 * not. **The RAW stored string is what is held**, and it is resolved against
 * the live project list at read time. Resolving it in the initialiser instead
 * looks equivalent and is not: projects arrive over IPC from `restore`, so at
 * the first render there are none, every stored id would be dropped as naming
 * a project that does not exist, and the wall would come up empty on every
 * launch. Held raw, it fills in as `restore` lands, and a project removed later
 * leaves the wall on its own with nothing written.
 *
 * That is also why the write only ever happens in `toggleSlot`: persisting the
 * resolved read would take a launch's momentarily-empty answer and make it the
 * stored truth.
 */
function useWallState(projects: ProjectDescriptor[]): WallState {
  const [on, setOnState] = useState(() => localStorage.getItem(WALL_KEY) === '1')
  const [stored, setStored] = useState(() => localStorage.getItem(WALL_SLOTS_KEY))
  const [columns, setColumnsState] = useState(() =>
    columnsFromStored(localStorage.getItem(WALL_COLUMNS_KEY)),
  )

  const slots = useMemo(() => slotsFromStored(stored, projects), [stored, projects])

  const setOn = useCallback((next: boolean) => {
    setOnState(next)
    localStorage.setItem(WALL_KEY, next ? '1' : '0')
  }, [])

  // Through the reader the stored value already goes through, so a menu item
  // and a hand-edited profile are clamped by one rule rather than two.
  const setColumns = useCallback((count: number) => {
    const clamped = columnsFromStored(String(count))
    setColumnsState(clamped)
    localStorage.setItem(WALL_COLUMNS_KEY, String(clamped))
  }, [])

  // The write sits in the updater, the shape `moveColumnTo` uses: it is
  // idempotent, so StrictMode's double invocation costs nothing. This is the
  // one moment the stored list is allowed to lose an id naming a project that
  // is gone, because it is the one moment a user asked for a change.
  const toggle = useCallback(
    (projectId: string) => {
      setStored((was) => {
        const next = JSON.stringify(toggleSlot(slotsFromStored(was, projects), projectId))
        localStorage.setItem(WALL_SLOTS_KEY, next)
        return next
      })
    },
    [projects],
  )

  return { on, slots, columns, setOn, setColumns, toggleSlot: toggle }
}

export function App() {
  const [state, dispatch] = useReducer(workspaceReducer, INITIAL_WORKSPACE_STATE)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [skillsCollapsed, setSkillsCollapsed] = useState(() => storedCollapsed(SKILLS_KEY, true))
  const [presetsCollapsed, setPresetsCollapsed] = useState(() => storedCollapsed(PRESETS_KEY, true))
  const [filesCollapsed, setFilesCollapsed] = useState(() => storedCollapsed(FILES_KEY, true))
  const [promptsCollapsed, setPromptsCollapsed] = useState(() => storedCollapsed(PROMPTS_KEY, true))
  const [gitCollapsed, setGitCollapsed] = useState(() => storedCollapsed(GIT_KEY, true))
  const [issuesCollapsed, setIssuesCollapsed] = useState(() => storedCollapsed(ISSUES_KEY, true))
  const [todosCollapsed, setTodosCollapsed] = useState(() => storedCollapsed(TODOS_KEY, true))
  const [notesCollapsed, setNotesCollapsed] = useState(() => storedCollapsed(NOTES_KEY, true))
  const [tabsCollapsed, setTabsCollapsed] = useState(() => storedCollapsed(TABS_KEY, true))
  // Open, where every other column defaults to collapsed. The browser column
  // is DRAWN only while the active project has a browser pane (`renderSlot`
  // mounts it whenever the workspace has one anywhere, and hides it where the
  // active project has none), so when it does appear it is because the user
  // has just asked for the pane it holds, and a 24px strip is not what they
  // asked for. The stored value still wins once there is one, so collapsing
  // it is remembered like any other column's.
  const [browserCollapsed, setBrowserCollapsed] = useState(() => storedCollapsed(BROWSER_KEY, false))
  // Whether the Todos column's create dialog is open. Held here rather than
  // inside `TodosPanel` so something outside that column can open it.
  const [creatingTodo, setCreatingTodo] = useState(false)
  // Every column starts hidden on a fresh profile, which is what shipped: the
  // window opens on terminal, not on a row of chrome.
  const [hiddenColumns, setHiddenColumns] = useState<ColumnVisibility>(() => ({
    tabs: storedCollapsed(HIDDEN_KEYS.tabs, true),
    files: storedCollapsed(HIDDEN_KEYS.files, true),
    skills: storedCollapsed(HIDDEN_KEYS.skills, true),
    presets: storedCollapsed(HIDDEN_KEYS.presets, true),
    prompts: storedCollapsed(HIDDEN_KEYS.prompts, true),
    git: storedCollapsed(HIDDEN_KEYS.git, true),
    issues: storedCollapsed(HIDDEN_KEYS.issues, true),
    todos: storedCollapsed(HIDDEN_KEYS.todos, true),
    notes: storedCollapsed(HIDDEN_KEYS.notes, true),
    // The one entry that defaults SHOWN, and the reason is that this column
    // is gated on a second thing none of the others are: `renderSlot` draws
    // it only where the active project has a browser pane, so a default of
    // shown still puts nothing on screen until there is something to show.
    // Defaulting hidden instead would mean a profile that already has
    // browser panes restores with them nowhere on screen and no menu item to
    // bring them back, since this column has neither an item nor a shortcut
    // of its own. What writes it is hide-all, its `restore`, and the effect
    // further down that follows the active project's browser panes.
    browser: storedCollapsed(HIDDEN_KEYS.browser, false),
  }))
  // The row's left-to-right order. Restored from whatever the last drag
  // wrote, or the shipped order on a fresh profile: see `orderFromStored`
  // for what a half-written or outdated value degrades to.
  const [columnOrder, setColumnOrder] = useState<ColumnSlot[]>(() =>
    orderFromStored(localStorage.getItem(ORDER_KEY)),
  )

  // Whether the terminal column is a wall, and what is in it. Beside the row's
  // order because it is the same kind of fact: how this window is arranged.
  const wallState = useWallState(state.projects)

  /** Move `id` to `toIndex` and persist the result. See `moveColumn`. */
  const moveColumnTo = useCallback((id: ColumnSlot, toIndex: number) => {
    setColumnOrder((was) => {
      const next = moveColumn(was, id, toIndex)
      localStorage.setItem(ORDER_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  // The one drag in progress: which column is being carried, and which gap it
  // is over. Both null outside a drag, which is also what keeps the gaps
  // themselves from rendering, see `gap` below.
  const [dragging, setDragging] = useState<ColumnSlot | null>(null)
  const [over, setOver] = useState<number | null>(null)

  // A drag released outside any gap (dropped on a pane, or cancelled with
  // Escape) never reaches a gap's own `onDrop`, so nothing there would clear
  // `dragging` and the gaps would stay on screen for the rest of the session.
  // `dragend` fires on the source element for every drag, wherever it ends,
  // and bubbles, so a single window listener catches the ones `onDrop` misses
  // without duplicating the state change on the ones it doesn't.
  useEffect(() => {
    if (dragging === null) return
    const end = (): void => {
      setDragging(null)
      setOver(null)
    }
    window.addEventListener('dragend', end)
    return () => window.removeEventListener('dragend', end)
  }, [dragging])

  const [paletteOpen, setPaletteOpen] = useState(false)
  // Set once the workspace exists. Until then this window knows nothing about
  // what is selected and must not say anything about it — see the effects.
  const [ready, setReady] = useState(false)
  // Fetched once alongside status, and kept current from whatever
  // `updateNotifications` hands back. Null until the initial fetch resolves,
  // which the mute toggle treats as "nothing to toggle yet" rather than
  // guessing at a shape it has not seen.
  const [notifications, setNotifications] = useState<NotificationConfig | null>(null)
  // The palette in force. Seeded from the command line rather than fetched,
  // because `main.tsx` has already painted the document from that same value
  // before this component mounted, and a second read over IPC could only
  // disagree with what is on screen. This state is what React renders from,
  // and what carries a change into every live terminal.
  const [theme, setTheme] = useState<ThemeId>(() => bootTheme())
  // Which editor panes have unsaved edits, renderer-only and never persisted
  // (see `dirtyPanes.ts`). Keyed by pane id rather than tab id: `TabBar` maps
  // a tab to its one pane before reading this.
  const [dirty, setDirtyPanes] = useState<DirtyPanes>({})
  // A release newer than this build, pushed by main once it finds one. Null
  // until then, and null again once the bar is downloaded, skipped or
  // dismissed: none of those close the app, so there is nothing else that
  // would clear it.
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  /**
   * Whether to warn that no dot will ever move. Null until the first read
   * answers, so a slow reply shows nothing rather than a strip that appears
   * and then retracts. Dismissal writes `false` and lasts the run — see
   * `HooksBar` for why it is not persisted.
   */
  const [hooksMissing, setHooksMissing] = useState<boolean | null>(null)
  // The pane `ConfirmClosePane` is asking about, or null when it is not open.
  // Only ever set by `requestClosePane` below, and only for a dirty pane.
  const [pendingClose, setPendingClose] = useState<string | null>(null)
  // Stable across renders on purpose: `FileView` puts this in its
  // view-building effect's dependency array, and a new function each render
  // would rebuild the `EditorView` (and drop the cursor) on every keystroke.
  /**
   * Painted first, stored second.
   *
   * The write is a round trip and the click has to feel instant, so the
   * document and the React state move immediately and the config catches up.
   * If the write fails, what is on screen is still the palette the user asked
   * for, and the stored value is corrected by the next change; the alternative
   * is a picker that stutters on every click to guard against a failure that
   * costs nothing when it happens.
   *
   * `applyTheme` as well as `setTheme` because they reach different things:
   * the first sets the custom properties every CSS surface reads, the second
   * is what re-renders the terminals, which cannot read those properties.
   */
  const onThemeChange = useCallback((id: ThemeId) => {
    setTheme(id)
    applyTheme(id)
    window.pterm.updateTheme(id).catch(() => undefined)
  }, [])

  const onDirtyChange = useCallback((paneId: string, isDirty: boolean) => {
    setDirtyPanes((was) => markDirty(was, paneId, isDirty))
  }, [])

  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason))
  }, [])

  // Clicking a column's own heading or strip moves only that column. The
  // localStorage write sits in the updater, same shape for all six; it is
  // idempotent, so StrictMode's double invocation costs nothing.
  /**
   * Show or hide one column outright, which is what the View menu's items and
   * their shortcuts do.
   *
   * Showing also un-collapses: a column asked for from the menu should arrive
   * open rather than as a strip the user has to click again. Hiding leaves the
   * collapse flag alone, so a column set aside and then hidden comes back as
   * the strip it was.
   */
  const setColumnHidden = useCallback((id: ColumnId, hidden: boolean) => {
    setHiddenColumns((was) => ({ ...was, [id]: hidden }))
    localStorage.setItem(HIDDEN_KEYS[id], hidden ? '1' : '0')
    // Hiding unmounts TodosPanel, so nothing there is left to clear its own
    // create-draft flag. Every path that hides the column, the shortcut, the
    // View menu item, and Hide All Columns, calls this function, so clearing
    // it here is the one place that covers all of them.
    if (hidden && id === 'todos') setCreatingTodo(false)
    if (!hidden) {
      setColumn[id](false)
      localStorage.setItem(COLUMN_KEY[id], '0')
    }
  }, [])

  /**
   * Collapse a column to its strip, or open it from one.
   *
   * The panel HEADING and the strip both call this. It never hides: setting a
   * column aside and not wanting it at all are different intents, and for a
   * while they were the same click, which left the strip — the only way back
   * without the menu — gone the moment you used it.
   */
  const toggleColumnCollapsed = useCallback((id: ColumnId) => {
    setColumn[id]((was: boolean) => {
      localStorage.setItem(COLUMN_KEY[id], was ? '0' : '1')
      return !was
    })
  }, [])

  const toggleSkills = useCallback(() => {
    // The View menu's item and its shortcut both land here, and both
    // mean presence: show the column, or take it off screen entirely.
    // Collapsing to the strip is the heading's job, not this one's.
    setColumnHidden('skills', !hiddenColumns.skills)
  }, [hiddenColumns.skills, setColumnHidden])
  const togglePrompts = useCallback(() => {
    // The View menu's item and its shortcut both land here, and both
    // mean presence: show the column, or take it off screen entirely.
    // Collapsing to the strip is the heading's job, not this one's.
    setColumnHidden('prompts', !hiddenColumns.prompts)
  }, [hiddenColumns.prompts, setColumnHidden])
  const toggleGit = useCallback(() => {
    // The View menu's item and its shortcut both land here, and both
    // mean presence: show the column, or take it off screen entirely.
    // Collapsing to the strip is the heading's job, not this one's.
    setColumnHidden('git', !hiddenColumns.git)
  }, [hiddenColumns.git, setColumnHidden])
  const toggleIssues = useCallback(() => {
    // The View menu's item and its shortcut both land here, and both
    // mean presence: show the column, or take it off screen entirely.
    // Collapsing to the strip is the heading's job, not this one's.
    setColumnHidden('issues', !hiddenColumns.issues)
  }, [hiddenColumns.issues, setColumnHidden])
  const toggleTodos = useCallback(() => {
    // The View menu's item and its shortcut both land here, and both
    // mean presence: show the column, or take it off screen entirely.
    // Collapsing to the strip is the heading's job, not this one's.
    setColumnHidden('todos', !hiddenColumns.todos)
  }, [hiddenColumns.todos, setColumnHidden])
  const toggleFiles = useCallback(() => {
    // The View menu's item and its shortcut both land here, and both
    // mean presence: show the column, or take it off screen entirely.
    // Collapsing to the strip is the heading's job, not this one's.
    setColumnHidden('files', !hiddenColumns.files)
  }, [hiddenColumns.files, setColumnHidden])
  const togglePresets = useCallback(() => {
    // The View menu's item and its shortcut both land here, and both
    // mean presence: show the column, or take it off screen entirely.
    // Collapsing to the strip is the heading's job, not this one's.
    setColumnHidden('presets', !hiddenColumns.presets)
  }, [hiddenColumns.presets, setColumnHidden])
  const toggleNotes = useCallback(() => {
    // The View menu's item and its shortcut both land here, and both
    // mean presence: show the column, or take it off screen entirely.
    // Collapsing to the strip is the heading's job, not this one's.
    setColumnHidden('notes', !hiddenColumns.notes)
  }, [hiddenColumns.notes, setColumnHidden])
  const toggleTabs = useCallback(() => {
    // The View menu's item lands here, and means presence: show the column,
    // or take it off screen entirely. There is no shortcut for this one, so
    // unlike its siblings only the menu ever calls it.
    setColumnHidden('tabs', !hiddenColumns.tabs)
  }, [hiddenColumns.tabs, setColumnHidden])

  // What was open when hide-all last closed everything. A ref, not state:
  // nothing renders from it, and it must not be persisted, because it answers
  // "what did I have open a moment ago" and a set restored from last week is
  // not that.
  const rememberedColumns = useRef<ColumnId[]>([])

  // `Dispatch<SetStateAction<boolean>>` rather than `(collapsed: boolean) =>
  // void`: these are React setters and `toggleColumnCollapsed` hands them an
  // updater, which the narrower type rejected.
  const setColumn: Record<ColumnId, Dispatch<SetStateAction<boolean>>> = {
    tabs: setTabsCollapsed,
    files: setFilesCollapsed,
    skills: setSkillsCollapsed,
    presets: setPresetsCollapsed,
    prompts: setPromptsCollapsed,
    notes: setNotesCollapsed,
    git: setGitCollapsed,
    issues: setIssuesCollapsed,
    todos: setTodosCollapsed,
    browser: setBrowserCollapsed,
  }

  const COLUMN_KEY: Record<ColumnId, string> = {
    tabs: TABS_KEY,
    files: FILES_KEY,
    skills: SKILLS_KEY,
    presets: PRESETS_KEY,
    prompts: PROMPTS_KEY,
    notes: NOTES_KEY,
    git: GIT_KEY,
    issues: ISSUES_KEY,
    todos: TODOS_KEY,
    browser: BROWSER_KEY,
  }

  // The ACTIVE project's browser panes, which is a different list from
  // `browserGroups` further down and the reason both exist. Membership in
  // this one region is per project: this is what decides whether the column
  // is in the row at all, and what the effect below counts to tell an open
  // or a close from a project switch. Derived up here, above the two readers
  // that need it, rather than beside the other browser derivations.
  const browserPanes = state.activeProjectId
    ? tabsOfProject(state, state.activeProjectId, 'browser')
    : []

  /**
   * What is actually on screen, which is what "all columns" is a statement
   * about.
   *
   * Identical to `hiddenColumns` except for the browser column, whose stored
   * flag is only half of whether it is drawn: `renderSlot` also requires the
   * active project to have a browser pane. Reading the raw flag instead
   * would have this window offering to hide a column that is not there, and
   * then hiding nothing when asked.
   *
   * Memoised because two consumers below take it as a dependency: a fresh
   * object every render would re-register the keydown listener that reaches
   * `hideAllColumns`, and would send the menu an IPC message on every render
   * rather than on every change.
   */
  const onScreenColumns: ColumnVisibility = useMemo(
    () => ({ ...hiddenColumns, browser: hiddenColumns.browser || browserPanes.length === 0 }),
    [hiddenColumns, browserPanes.length],
  )

  /**
   * Close every column, or reopen the set the last close remembered.
   *
   * Which of the two it does is decided by whether anything is open, so the
   * one item and the one keystroke cover both directions.
   */
  const hideAllColumns = useCallback(() => {
    // Reads and writes the HIDDEN flags, not the collapse ones: this item is
    // the menu's, and the menu's business is presence.
    //
    // The DIRECTION comes off `onScreenColumns`, so the item does what its
    // label says (main computes that label from the same answer). What it
    // hides, remembers and restores comes off the STORED flags, because
    // `setColumnHidden` writes those to localStorage. The two differ for the
    // browser column alone, and only there does it matter: on a project with
    // no browser panes its on-screen answer is "not there" for a reason that
    // is not a preference, so writing that back would store a hide the user
    // never asked for, for every project, with no menu item and no shortcut
    // to undo it. Remembering off the stored flag is the other half: a hide
    // taken while looking at a browserless project has to put the column back
    // on the second press.
    const next = anyOpen(onScreenColumns)
      ? (() => {
          const closed = hideAll(hiddenColumns)
          rememberedColumns.current = closed.remembered
          return closed.next
        })()
      : restore(hiddenColumns, rememberedColumns.current)
    for (const id of COLUMN_IDS) setColumnHidden(id, next[id])
  }, [onScreenColumns, hiddenColumns, setColumnHidden])

  // Main cannot read localStorage or React state, so the menu's checkmarks
  // would otherwise be a guess. Sent on mount too, not only on change: a
  // relaunch restores these from localStorage without any toggle firing.
  useEffect(() => {
    // The HIDDEN flags: a checkmark means the column is on screen, and a
    // column collapsed to its strip is still on screen. `onScreenColumns`
    // rather than the raw flags, so the label main computes from these and
    // the direction `hideAllColumns` takes are read off the same answer.
    window.pterm.columnsVisible(onScreenColumns)
  }, [onScreenColumns])

  // Same reason and the same route as the effect just above, for the wall's
  // own two facts: main cannot read `localStorage`, so the View menu's Wall
  // checkbox and its column-count radios would otherwise be guesses, and a
  // toggle made from the palette has to reach them without a click on the
  // menu itself.
  useEffect(() => {
    window.pterm.wallVisible({ on: wallState.on, columns: wallState.columns })
  }, [wallState.on, wallState.columns])

  // The *Collapsed booleans as one ColumnVisibility, for showsTabBar.
  const collapsedColumns: ColumnVisibility = {
    tabs: tabsCollapsed,
    files: filesCollapsed,
    skills: skillsCollapsed,
    presets: presetsCollapsed,
    prompts: promptsCollapsed,
    git: gitCollapsed,
    issues: issuesCollapsed,
    todos: todosCollapsed,
    notes: notesCollapsed,
    browser: browserCollapsed,
  }

  const project = activeProject(state)
  const currentTabId = activeTabId(state)
  // Grouped ONCE, here, and read by two consumers: the bar draws it and
  // `⌥⌘1..9` indexes it, though only while `keyRegion` is 'terminal' (see the
  // Digit branch of the keydown handler below, which picks this list or
  // `browserTabEntries`). A `TabBar` that sorted privately would leave `⌥⌘3`
  // selecting something other than the third tab on screen, and no unit test
  // could see the disagreement.
  const tabEntries = state.activeProjectId
    ? groupedTabs(tabsOfProject(state, state.activeProjectId, 'terminal'), state.tabs)
    : []
  // Hoisted out of the JSX below because the welcome page's condition is read
  // off it. "No visible group" is the literal statement of an empty pane area,
  // and it is not the same as "no tabs": a tab whose kids were all boxed by an
  // earlier row emits no group at all (`workspace.ts:667`).
  //
  // The wall, when it is on, and null when it is not — which is the value that
  // keeps every group on `inset-0` and exactly one of them visible, as it was
  // before wall mode. It is passed HERE and nowhere else: `browserGroups` below
  // must never see a wall, which is what keeps the browser region
  // single-visible (`paneGroups` repeats the region test for the same reason).
  const wallView = wallState.on ? { slots: wallState.slots, columns: wallState.columns } : null
  const groups = paneGroups(state, 'terminal', wallView)
  // "No visible group" still carries this, and a wall with no slots at all is
  // exactly that case — but a wall that HAS cells is not an empty pane area
  // even when none of them is filled. Its placeholders already say what to do
  // and its headers already offer the pane picker, so the welcome drawn over
  // them was two answers to one question, printed on top of each other
  // (measured: the hint row landed across both cells' placeholder text).
  const showWelcome =
    !groups.some((group) => group.visible) && (wallView === null || wallState.slots.length === 0)
  // The other region's two lists, derived exactly as the terminal region's
  // are above. `paneGroups` reads every pane, so a browser pane belonging to
  // another project keeps its box (and its page) here while the bar, which is
  // per project, does not list it. It keeps them for as long as the column is
  // MOUNTED, which is not the same as drawn: see `renderSlot`'s `'browser'`
  // case, where the column is put away rather than unmounted precisely so
  // that this list's other projects survive a switch.
  const browserGroups = paneGroups(state, 'browser')
  // Grouped from `browserPanes` (derived above, beside its other reader), so
  // the bar lists the active project's browser panes and not every project's.
  const browserTabEntries = groupedTabs(browserPanes, state.tabs)
  // Whether a project is active, is not Unsorted, and its cwd is on disk:
  // see `canOpenSession` in workspace.ts, which `welcomeHint` also reads so
  // the two cannot silently disagree.
  const canOpen = canOpenSession(state)

  /**
   * Every browser pane in the workspace, not the active project's.
   *
   * The effect below drives ONE stored flag, and that flag is global: there
   * is a single `pterm:browserHidden`, read by a single `hiddenColumns`
   * entry, hidden and restored by a single hide-all. A rule of the form
   * "this project's count fell to zero, so hide" writes a global answer from
   * a local question, and is then wrong for every other project: measured,
   * opening and closing a browser in project B hid a column project A still
   * had a pane for, with no menu item or shortcut to bring it back. So the
   * count this watches has the same scope the flag does.
   *
   * What stays per project is which panes are DRAWN, which is `renderSlot`'s
   * business and does not touch the stored flag at all.
   */
  const browserPaneTotal = state.panes.filter((pane) => regionOf(pane) === 'browser').length

  // The total as of the last run of the effect below, or null before the
  // workspace has arrived. A ref rather than state: nothing renders from it,
  // and a second render on every open would be a render scheduled to record
  // something already on screen.
  const browserPaneCount = useRef<number | null>(null)

  /**
   * The browser column follows the browser panes: opening one brings the
   * column on screen, closing the last one anywhere takes it away.
   *
   * Unhiding is what any open does, not only the first: `setColumnHidden`
   * also un-collapses, so the pane a user asks for while the column is a
   * strip arrives on a column they can see. That is the whole of "a manual
   * hide sticks until the next browser opens".
   *
   * A project switch is neither an open nor a close, and needs no guard here
   * to be treated as neither: it does not change how many browser panes the
   * workspace holds, so this effect does not run for one.
   *
   * `ready` is what separates a restore from an open. The panes arrive in one
   * dispatch alongside it, and the run that first sees them is the restored
   * state rather than something the user just did, so it records the total
   * and leaves the stored flag alone. That is what lets a hide survive a
   * relaunch.
   */
  useEffect(() => {
    if (!ready) return
    const was = browserPaneCount.current
    browserPaneCount.current = browserPaneTotal
    if (was === null) return
    if (browserPaneTotal > was) setColumnHidden('browser', false)
    else if (browserPaneTotal === 0 && was > 0) setColumnHidden('browser', true)
  }, [ready, browserPaneTotal, setColumnHidden])

  /**
   * Where focus last went, which is not the same as which region the keys act
   * on: `keyRegion` below is that, and it overrides this one.
   *
   * Not persisted, and deliberately: a relaunch restores panes and columns but
   * focuses nothing, so a stored answer would be a claim about a state the new
   * window is not in.
   */
  const [activeRegion, setActiveRegion] = useState<Region>('terminal')

  /**
   * Follow the user between the two regions.
   *
   * Two RULES about where a pointer or a focus landed, rather than a setter on
   * each control that should claim a region: most of this app's chrome focuses
   * nothing when clicked, so a list would have to name every project row,
   * heading, panel body and title bar, and would go stale the day one was
   * added. The two setters that remain (`selectPane` and `onSelectSession`)
   * are the routes these rules cannot see at all, and each says which.
   *
   * `pointerdown` is the general case and carries every click on host chrome.
   * It reads the EVENT TARGET, not `document.activeElement`: measured
   * 2026-08-12, of five chrome clicks driven after focus was put in a guest
   * page, four left `activeElement` at `BODY`, including a click on the
   * browser column's own heading (the button takes focus and gives it back on
   * the way out). Reading the focused element there answers 'terminal' for a
   * click plainly inside the browser region. The target was right in all five,
   * the title bar's drag region included, which does NOT swallow the event.
   *
   * `focusin` covers focus that arrives without a pointer: ⌘T's new terminal
   * focuses its own xterm, and nothing clicked anything.
   *
   * A click on GUEST CONTENT inside a `<webview>` is deliberately not handled,
   * and this is the part worth knowing before adding a third listener for it.
   * Measured 2026-08-11 with capture listeners on the host document for
   * `focusin`, `focusout`, `mousedown`, `pointerdown` and `click`, the host saw
   * NONE of them for three separate guest clicks: only a `focusout` on whatever
   * it had focused and a `window` blur. `focus` and `blur` on the guest's own
   * `WebContents` in main fired zero times across the same six clicks, so there
   * is no main-side signal either. A `blur` listener claiming the region for
   * the browser was written on that measurement and then removed: it could not
   * change any outcome, because `activeRegion` is read only through
   * `keyRegion` and only by the keydown handler, and while the guest holds
   * focus the page owns the keyboard and this window receives no keystroke at
   * all. Focus comes back out of a page by a click on host chrome, which
   * `pointerdown` above decides on its own. See the browser region spec's note
   * "⌘W does not reach the app from inside a focused page (accepted
   * 2026-08-12)" for the product decision that settles it.
   */
  useEffect(() => {
    const pointed = (event: Event): void => {
      const target = event.target
      setActiveRegion(target instanceof Element && inBrowserRegion(target) ? 'browser' : 'terminal')
    }
    const focused = (): void => {
      setActiveRegion(inBrowserRegion(document.activeElement) ? 'browser' : 'terminal')
    }
    document.addEventListener('pointerdown', pointed, true)
    document.addEventListener('focusin', focused, true)
    return () => {
      document.removeEventListener('pointerdown', pointed, true)
      document.removeEventListener('focusin', focused, true)
    }
  }, [])

  /**
   * The region ⌘W and ⌥⌘1-9 act on.
   *
   * Derived rather than stored, which is the whole point: `activeRegion`
   * records where focus last went, and the column can leave the screen
   * afterwards with no focus event to say so: a hide, a hide-all, a project
   * switch to one with no browser panes, or the last browser pane closing.
   * Reading the stored value in any of those would leave ⌘W closing a pane in
   * a region that is not on screen.
   *
   * `onScreenColumns.browser` is exactly that test and is already computed
   * above (the stored hide OR no browser pane in the active project), so this
   * and what `renderSlot` draws cannot drift apart. It is true when the region
   * is NOT there, hence the order of the branches.
   *
   * A COLLAPSED column is not one of these states: it is still on screen, its
   * panes are still mounted, and its bar comes straight back.
   */
  const keyRegion: Region = onScreenColumns.browser ? 'terminal' : activeRegion

  // `type` is a declaration of intent recorded on the tab, not inferred from
  // `command` — it decides the launch state a fresh dot starts in
  // (`stateForOpen` in src/main/status/machine.ts) and, for `claude`, gives a
  // broken hook install a hollow dot to show instead of nothing. It must be
  // named by the caller: `PresetsPanel`'s dedicated `claude` button passes
  // `'claude'`, a repository or user preset passes `'preset'`, and a bare
  // ⌘T/+ shell defaults to `'shell'`.
  const launch = useCallback(
    (command: string | undefined, type: TabType = 'shell') => {
      if (!project || !canOpen) return
      window.pterm
        .open({ projectSlug: project.slug, cwd: project.cwd, command, type })
        .then((tab) => dispatch({ type: 'opened', tab }))
        .catch(fail)
    },
    [project, canOpen, fail],
  )

  const openTab = useCallback(() => launch(undefined), [launch])

  /**
   * Open one file of the active project in an editor pane of its own tab.
   *
   * `opened` is the dispatch `launch` uses for a new terminal, and it both adds
   * the pane and selects it. That is enough here for the reason it is enough
   * there: an editor pane founds its own tab, so the id it selects by is the
   * tab's id as well.
   *
   * A null reply is main declining (no such project, a path that leaves it, or
   * a file that will not read), and nothing is dispatched, so the click did
   * nothing rather than opening a tab that could only say so.
   *
   * No `canOpen` gate, unlike `launch`: that test is about whether a project
   * can host a tmux session, and an editor pane needs none. Unsorted, the one
   * project `canOpen` exists to refuse, is synthetic and in no config file, so
   * main's own lookup answers null for it.
   */
  const openFile = useCallback(
    (relPath: string) => {
      if (!project) return
      window.pterm
        .openEditor(project.id, relPath)
        .then((tab) => {
          if (tab) {
            dispatch({ type: 'opened', tab })
            return
          }
          // A null answer is a refusal, and it used to be silent: the click
          // did nothing and said nothing. Routed through `fail` because that
          // is already this call's `.catch`, so a refusal main returns and a
          // fault main throws reach the user the same way, which is what they
          // are from the outside.
          //
          // The reason is deliberately not named. Main answers null for an
          // unknown project, a path that would leave the project, and a file
          // it cannot read, and the renderer cannot tell those apart from a
          // null. Naming one would be a guess.
          fail(`Could not open ${relPath}`)
        })
        .catch(fail)
    },
    [project, fail],
  )

  /**
   * Everything a terminal pane needs to make the file paths in its output
   * ⌘-clickable, or undefined when there is no project to resolve them
   * against.
   *
   * Undefined rather than a set of no-op callbacks: `Terminal` registers no
   * provider at all in that case, so an Unsorted pane underlines nothing
   * instead of underlining paths that would refuse.
   *
   * The routing lives here rather than in `Terminal` because it is a question
   * about what a project can SHOW: a source file founds an editor pane
   * (`openFile`, and every refusal it already handles), and a file the pane
   * cannot render goes to the system opener instead (`fsOpen`), which is the
   * choice made for images and pdfs. `opensInEditor` decides by extension
   * alone, so neither branch reads the file to find out which it is.
   */
  const pathLinks = useMemo(
    () =>
      project === undefined
        ? undefined
        : {
            cwd: project.cwd,
            probe: (relPaths: string[]): Promise<string[]> =>
              window.pterm.fsProbe(project.id, relPaths),
            open: (relPath: string): void => {
              if (opensInEditor(relPath)) {
                openFile(relPath)
                return
              }
              window.pterm
                .fsOpen(project.id, relPath)
                .then((opened) => {
                  // The same shape `openFile` uses for its own refusal: main
                  // answers false for an unknown project, a path that leaves
                  // it, and a file the system declines, and the renderer
                  // cannot tell those apart, so it names none of them.
                  if (!opened) fail(`Could not open ${relPath}`)
                })
                .catch(fail)
            },
          },
    [project, openFile, fail],
  )

  /**
   * Open a fresh browser pane for the active project, in a new tab of its
   * own.
   *
   * Mirrors `openFile` above: `opened` both adds the pane and selects it,
   * which is enough here for the same reason it is enough there: a browser
   * pane founds its own tab, so the id it selects by is the tab's id.
   *
   * `window.pterm.openBrowser` is called with no `url`, unlike `openFile`
   * with its `relPath`: a browser pane starts with nothing to show, and main
   * (Task 3) always stores `about:blank` for that case rather than treating
   * an absent URL as a reason to refuse. So the only refusal left to handle
   * is `!project`, not a null reply. `openBrowser` answers null only for an
   * unknown project id, and `project` is already resolved from the active
   * one before this ever calls it.
   */
  const openBrowserPane = useCallback(() => {
    if (!project) return
    window.pterm
      .openBrowser(project.id)
      .then((tab) => {
        if (tab) {
          dispatch({ type: 'opened', tab })
          // The palette reaches here from the keyboard, with no pointer in the
          // browser column for the `pointerdown` rule to see, and nothing
          // focuses a fresh `<webview>`, so no focus event says it either.
          // Inside the success branch, so a refusal leaves the keys where they
          // were.
          setActiveRegion('browser')
          return
        }
        fail('Could not open a browser pane')
      })
      .catch(fail)
  }, [project, fail])

  /**
   * Whether the tab bar's browser button has a project to open a pane for.
   *
   * Not `canOpenSession`, which the `+` beside it reads: that asks whether a
   * PTY can start here, and a browser pane starts none and never visits the
   * cwd it records, so a project whose directory has been renamed can still
   * have one. What `openBrowser` needs is a row in `config.projects` to look
   * the id up in, and both states that fail that test are reachable from a
   * bar that is on screen:
   *
   * - no project at all, since `showsTabBar` reads column visibility and
   *   nothing else, so the bar renders on the welcome page too. The press
   *   would hit the early return below and do nothing at all;
   * - Unsorted, which the renderer holds as a project (`withUnsorted`, in
   *   `ipc/restore.ts`) while config has no row for it. The press would reach
   *   main, come back null and raise an error banner.
   *
   * Deliberately not the browser column's own `canOpen={project !== undefined}`
   * either. That one admits Unsorted, which is the second case above, and its
   * `+` puts that banner up today. Left as it is: it is one column over and
   * not this button.
   */
  const canOpenDevServer = project !== undefined && project.id !== UNSORTED_ID

  /**
   * Open a browser pane on the URL a dev server in the active project last
   * announced, or a blank one when none has.
   *
   * The two calls take DIFFERENT names for the same project. `devServerUrl`
   * is asked by `project.slug`, because a pane carries only a slug and that is
   * what main files a URL under, while `openBrowser` is asked by
   * `project.id`, which is what it looks a project row up by.
   *
   * Nothing turns an id into a slug on the LOOKUP path: `devServerUrl`'s
   * handler reads the registry by the string it is handed and consults no
   * config at all (`ipc/register.ts`). `openBrowser` does read a slug off the
   * row it found by id, but only to stamp the pane it writes, and that
   * conversion is not shared with the other handler. So getting the two the
   * wrong way round is not a crash: the URL lookup answers null, which is
   * exactly what "no server has announced itself" answers, and the button goes
   * on opening blank panes.
   *
   * `?? undefined` because null is not absent to a parameter that is
   * `url?: string`. Main writes `about:blank` for the absent case, which is
   * the no-server behaviour, so there is no second branch here for it.
   *
   * A second callback rather than a URL parameter on `openBrowserPane` above:
   * that one is handed to `BrowserColumn`'s `onNew`, which becomes a button's
   * `onClick`, so a first parameter of any kind would arrive as a
   * `MouseEvent`.
   */
  const openDevServer = useCallback(() => {
    if (!project) return
    window.pterm
      .devServerUrl(project.slug)
      .then((url) => window.pterm.openBrowser(project.id, url ?? undefined))
      .then((tab) => {
        if (tab) {
          dispatch({ type: 'opened', tab })
          // The same move `openBrowserPane` makes, and for the same reason:
          // the pane that just opened is in the browser column, and nothing
          // focuses a fresh `<webview>` on its own. The press that got here
          // was in the TERMINAL column, so the `pointerdown` rule has just
          // pointed the keys at that one.
          setActiveRegion('browser')
          return
        }
        fail('Could not open a browser pane')
      })
      .catch(fail)
  }, [project, fail])

  /**
   * Open a read-only diff pane for one path of the active project's
   * repository, in a new tab.
   *
   * Mirrors `openFile` above: `relPath` here is repo-relative (it comes
   * straight from `GitPanel`'s `change.path`, which `gitChanges` reported),
   * not project-relative, which is why `openDiff` in main resolves it against
   * the repository root rather than the project's `cwd`.
   */
  const openDiff = useCallback(
    (relPath: string, side: DiffSide) => {
      if (!project) return
      window.pterm
        .openDiff(project.id, relPath, side)
        .then((tab) => {
          if (tab) dispatch({ type: 'opened', tab })
          else fail(`Could not open a diff for ${relPath}`)
        })
        .catch(fail)
    },
    [project, fail],
  )

  // The selection is a PANE id — the tab bar lists panes — so this is the
  // pane ⌘D splits, ⌘W closes and ⌘⌥arrow moves off. Every route that changes
  // which pane is active writes it, so the tab bar's highlight, the focused
  // xterm and what `setActive` tells main are one fact and cannot drift apart.
  const activePaneId = currentTabId

  /*
   * The history overlay, in three pieces of state.
   *
   * `historyPane` is which pane is showing it, or null for none. `historyScope`
   * and `historyEntries` are what it is showing, held HERE rather than in the
   * overlay because of a timing constraint the overlay cannot satisfy:
   * `attachCustomKeyEventHandler` in `Terminal.tsx` has to answer "is this Up
   * mine?" with a boolean, on the spot, while reading the history file is an
   * IPC round trip. So the list for the current project is kept fetched, and
   * the synchronous answer is a length check on something already in hand.
   *
   * The cost of that is honest and worth stating, and it runs in both
   * directions.
   *
   * UNDER-TRIGGERING: for the first moment after a project is selected, before
   * its fetch resolves, this holds no entries and Up goes to the shell. That is
   * exactly what a project with no history does, which is the documented
   * passthrough, so a single such press is indistinguishable from correct. What
   * that argument does NOT excuse is staying wrong: an empty answer has to
   * expire, or the app serves it for the rest of the session. `historyNonce`
   * below is what expires it.
   *
   * OVER-TRIGGERING: the answer comes from the last fetch, so if the file has
   * been emptied or rewritten since, Up can swallow the key on a list that has
   * gone, open, and then draw the empty row once the refetch lands. That is the
   * state the spec's third passthrough rule exists to prevent. It needs the
   * history file to lose every entry for this project between two Ups, and the
   * only alternative is to make Up wait on IPC before deciding, which would put
   * a round trip in front of a keystroke the shell may be about to receive.
   */
  const [historyPane, setHistoryPane] = useState<string | null>(null)
  const [historyScope, setHistoryScope] = useState<HistoryScope>('project')
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([])
  /*
   * A counter with no meaning of its own, bumped by `requestHistory` below to
   * ask the effect for a fresh answer.
   *
   * Every other input to that effect is something the user changed on screen,
   * and none of them move when the history FILE changes underneath a running
   * app. Installing the shell integration and then running the first command
   * is exactly that: the list goes from empty to non-empty with the project,
   * the scope, the pane and the overlay all untouched. Without something to
   * change, the effect would keep serving the empty answer it fetched at
   * launch, and Up would keep passing through, for as long as the app stayed
   * open on that project.
   */
  const [historyNonce, setHistoryNonce] = useState(0)

  /**
   * Refetch on every input the answer depends on.
   *
   * `historyPane` is a dependency so the list is refreshed each time the
   * overlay opens and again when it closes: a command run in a pane since the
   * last fetch should be in the list the next Up produces. `historyScope` is
   * one because widening the scope with Tab IS this call, made again.
   * `activePaneId` is one so moving between panes picks up whatever the pane
   * being left has run, which is the cheapest refresh point there is.
   * `historyNonce` is the one input the user cannot see; see its declaration.
   */
  useEffect(() => {
    const cwd = project?.cwd
    if (cwd === undefined) {
      setHistoryEntries([])
      return
    }
    let cancelled = false
    window.pterm
      .historyList(cwd, historyScope)
      .then((found) => {
        if (!cancelled) setHistoryEntries(found)
      })
      .catch(() => {
        // Swallowed rather than routed to `fail`: a history file that cannot be
        // read is a reason to leave Up to the shell, not a startup error banner
        // across an app that is otherwise working.
        if (!cancelled) setHistoryEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [project?.cwd, historyScope, historyPane, activePaneId, historyNonce])

  /**
   * Put the overlay away and give the keyboard back to the pane.
   *
   * The scope goes back to `project` with it. The spec's default is the current
   * project, and resetting here is what makes that true of every opening rather
   * than only the first: it also means the length check in `requestHistory`
   * below is always asking about the scope the overlay is about to open at.
   */
  const closeHistory = useCallback((paneId: string) => {
    setHistoryPane(null)
    setHistoryScope('project')
    focusTerminal(paneId)
  }, [])

  /**
   * Answer one pane's Up. `true` means the overlay took it.
   *
   * Every `false` here is a case from the spec's passthrough rule, and the rule
   * is that Up must reach zsh rather than open an empty list. "Shell
   * integration is not installed" needs no test of its own: without the hook
   * there is no history file, `historyList` returns nothing, and the length
   * check below is already the answer.
   */
  const requestHistory = useCallback(
    (paneId: string): boolean => {
      if (historyPane !== null) return false
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (pane?.type !== 'shell') return false
      if (historyEntries.length === 0) {
        // Declining is correct, and on its own it is also a dead end. Nothing
        // else asks again once the list is empty: the overlay never opens, so
        // `historyPane` never moves, and a user who has just installed the
        // integration and run a command would press Up forever against the
        // answer this app fetched before either of those happened. Bumping the
        // nonce makes the refusal itself the trigger, so the press after this
        // one is asking about the file as it is now.
        setHistoryNonce((count) => count + 1)
        return false
      }
      setHistoryPane(paneId)
      return true
    },
    [historyPane, state.panes, historyEntries],
  )

  /*
   * A file dropped anywhere that is not a terminal pane does nothing.
   *
   * Electron's default for a file dropped on a page is to NAVIGATE to it, which
   * replaces the whole app with the file's contents and no way back short of a
   * relaunch — the window has no address bar. The panes' own handlers call
   * `preventDefault` and type the paths; this is the backstop for every other
   * pixel of the window, including the gaps between panes.
   *
   * Capture phase, so it runs before anything inside can let the event through
   * by not handling it. It does not stop propagation: a pane's own handler
   * still runs and still types.
   */
  useEffect(() => {
    const swallow = (event: DragEvent): void => event.preventDefault()
    window.addEventListener('dragover', swallow, true)
    window.addEventListener('drop', swallow, true)
    return () => {
      window.removeEventListener('dragover', swallow, true)
      window.removeEventListener('drop', swallow, true)
    }
  }, [])

  // Switching pane or tab takes the overlay with it. It is anchored inside one
  // pane's box and is unmounted the moment that pane stops being the active
  // one, so leaving `historyPane` set would make the next Up on it a no-op:
  // `requestHistory` reads a non-null `historyPane` as "already open".
  useEffect(() => {
    setHistoryPane(null)
    setHistoryScope('project')
  }, [activePaneId])

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
      window.pterm
        .closePane(paneId)
        .then((shape) => dispatch({ type: 'closedPane', paneId, shape }))
        .catch(fail)
    },
    [fail],
  )

  // The prompt is only for a pane with unsaved edits. A terminal pane is never
  // in this map, so this is not a kind test wearing a dirtiness costume: a
  // terminal closing has always been immediate and stays that way.
  const requestClosePane = useCallback(
    (paneId: string) => {
      if (dirty[paneId] === true) {
        setPendingClose(paneId)
        return
      }
      closePane(paneId)
    },
    [dirty, closePane],
  )

  const cancelClose = useCallback(() => setPendingClose(null), [])

  // Discarding drops the id from the dirty map itself: `closePane`'s async
  // round trip through the channel would clear it too, once the pane actually
  // unmounts (see `FileView`'s build-effect cleanup), but that only runs on
  // success. Clearing it here is what keeps the dot from surviving a click
  // the user already answered.
  const discardClose = useCallback(() => {
    if (pendingClose) {
      closePane(pendingClose)
      setDirtyPanes((was) => forgetPane(was, pendingClose))
    }
    setPendingClose(null)
  }, [pendingClose, closePane])

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
      // The axis the user asked for, sent as asked. Main writes the same value
      // (`register.ts`, `layout.dir`), so there is one rule and one authority
      // for it rather than a local computation main can override.
      //
      // This used to read the tab's own axis off `state` whenever the tab was
      // drawn as more than one box, mirroring a ruling main applied by counting
      // the kids on its saved row. Both halves are gone with that ruling: a
      // split now re-orients the tab it lands in. See `SplitRequest.dir` for
      // what that costs and why it is paid.
      //
      // Refused here rather than in main, because this is where the only
      // cell-accurate numbers are: main has no idea what a column is. `dir` is
      // the dimension the carve actually happens along, now that nothing
      // overrides it, so it is the one to measure against: a check on the other
      // axis could refuse a fine split for a floor that was never in play, and
      // let a genuinely too-narrow one through. A split that cannot give the new
      // pane its floor would produce a pane too small to use, which is 2b's
      // "sliver of a sliver" answered before it happens rather than tolerated
      // after.
      const wouldBe = dir === 'row' ? half(grid.cols) : half(grid.rows)
      const floor = dir === 'row' ? MIN_PANE_COLS : MIN_PANE_ROWS
      if (wouldBe < floor) {
        setError(`Not enough room to split: a pane needs at least ${floor} ${dir === 'row' ? 'columns' : 'rows'}`)
        return
      }
      window.pterm
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
    // No `state`: the axis no longer comes from the tab's own row, so nothing
    // here reads the workspace. Leaving it in would rebuild this callback on
    // every status tick for no reason.
    [activePaneId, fail],
  )

  /** Drag one pane onto another to merge them into a split. */
  const joinPanes = useCallback(
    (paneId: string, targetPaneId: string) => {
      void window.pterm
        .joinPane(paneId, targetPaneId)
        .then((shape) => dispatch({ type: 'joined', shape }))
        // Shown, not logged. A failed join is not a gesture that quietly did
        // nothing: main detaches the pane before it touches tmux, and while
        // it puts the pane back whenever tmux can be put back too, the paths
        // it cannot undo leave a terminal on screen that is no longer wired
        // to anything. A user who is told the drag failed knows to look;
        // `console.error` reaches nobody outside devtools.
        .catch(fail)
    },
    [dispatch, fail],
  )

  /**
   * Whether dragging `from` onto `to` would do anything. Passed to both
   * `TabsPanel` and `TabBar` so the two surfaces refuse identically: neither
   * of them knows about tab rows or projects, so the rule lives here once
   * instead of being derived twice.
   */
  const canJoin = useCallback(
    (from: string, to: string): boolean => {
      if (from === to) return false
      const fromPane = state.panes.find((pane) => pane.id === from)
      const toPane = state.panes.find((pane) => pane.id === to)
      if (!fromPane || !toPane) return false
      if (fromPane.projectSlug !== toPane.projectSlug) return false
      // Kinds do not move between regions, so a drag that crosses the boundary
      // is refused rather than converted. Here rather than in `TabBar`, for the
      // reason above: one rule both surfaces read, not a second one derived per
      // bar. `TabBar` could not express it anyway, since each bar is handed only
      // its own region's tabs and cannot resolve a pane id from the other.
      //
      // Not the only thing standing in the way, and not redundant either.
      // `BrowserColumn` passes `capabilities={{ join: false }}`, which makes
      // every browser row non-draggable and makes the browser bar refuse every
      // drop, so neither direction is reachable with a pointer today. What that
      // flag does NOT cover is a `drop` whose `dataTransfer` already carries a
      // browser pane id arriving on a TERMINAL row: that row asks THIS function,
      // not the browser bar's, and before this line it answered yes and sent a
      // `joinPane` main then rejected. `browserRegion.spec.ts`'s cross-region
      // test dispatches exactly that and goes red without this line.
      if (regionOf(fromPane) !== regionOf(toPane)) return false
      // Falls back to the pane's own id rather than null, because a pane no
      // row names is a tab of one that has never been split, and reading
      // that as "unknown, so refuse" would make the commonest case in the
      // app undraggable.
      const tabOf = (paneId: string) =>
        state.tabs.find((row) => row.layout.kids.includes(paneId))?.id ?? paneId
      return tabOf(from) !== tabOf(to)
    },
    [state.panes, state.tabs],
  )

  /** Make `paneId` the pane the keyboard talks to, and record it on its tab. */
  const selectPane = useCallback(
    (paneId: string) => {
      // For the one caller that reaches here with no pointer and no focus
      // event of its own, which the `pointerdown` rule above cannot see:
      // `focusPane`, which is ⌘⌥ + an arrow. A pane that focuses nothing when
      // it is selected would otherwise leave the browser region holding the
      // keys after the user had plainly moved off it.
      //
      // The palette's session list is NOT among them: `onSelectSession` never
      // calls this, and sets the region from its chosen pane itself.
      //
      // Above the early return rather than below, so selecting the pane that
      // is already active still claims the region.
      setActiveRegion('terminal')
      if (paneId === activePaneId) return
      const row = tabOfPane(state, paneId)
      if (row) dispatch({ type: 'activatedPane', tabId: row.id, paneId })
      dispatch({ type: 'activatedTab', id: paneId })
    },
    [state, activePaneId],
  )

  /**
   * Choose a pane by clicking it, which on the wall also chooses its project.
   *
   * **Wall focus IS the active project.** That is the whole of why every
   * project-scoped column follows a click in a cell without the wall inventing
   * a focus concept of its own, and it is why this is a dispatch rather than a
   * second piece of state: `activatedProject` is what ⌘1-9, the sidebar and the
   * palette already send.
   *
   * The early return is the point of the gate. With the wall off this is
   * `selectPane` and nothing else, so normal mode dispatches exactly what it
   * dispatched before — a click on a pane belonging to some other project (a
   * state the terminal column cannot reach without a wall) would otherwise
   * start switching projects under the user.
   */
  const choosePane = useCallback(
    (pane: TabDescriptor) => {
      selectPane(pane.id)
      if (!wallState.on) return
      dispatch({ type: 'activatedProject', id: projectIdForTab(state.projects, pane) })
    },
    [selectPane, wallState.on, state.projects],
  )

  /**
   * Change one project's row here and now, so a wall cell repaints before the
   * config write lands.
   *
   * Painted first, stored second, the trade `onThemeChange` states — but here
   * it is not only about latency. `setWallPin` and `setWallFollow` are fire and
   * forget and nothing pushes the written config back into this window, so
   * without this the cell would not change until the next launch.
   */
  const patchProject = useCallback(
    (id: string, patch: Partial<ProjectDescriptor>) => {
      dispatch({
        type: 'projects',
        projects: state.projects.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      })
    },
    [state.projects],
  )

  /** A click on a cell's header, which means the same as a click in its pane. */
  const focusWallCell = useCallback(
    (projectId: string, paneId: string | undefined) => {
      dispatch({ type: 'activatedProject', id: projectId })
      // The cell's own pane, not just its project. `activePaneId` is the active
      // project's active TAB, which need not be the pinned one, so focusing the
      // project alone could take the keyboard to a pane the wall is not showing.
      if (paneId !== undefined) selectPane(paneId)
    },
    [selectPane],
  )

  /**
   * Pin a pane to a cell, or take the pin off.
   *
   * `setWallPin` resolves the OWNER from the pane rather than taking a project
   * id (`src/main/state/wallPin.ts`), on the argument that a pane carries the
   * only authority on whose it is. An unpin therefore still has to name a pane
   * of this project, and `current` is the one available: the pane coming off.
   * `WallCell` only draws the row that sends `null` while there is one.
   */
  const pinWallPane = useCallback(
    (projectId: string, paneId: string | null, current: string | undefined) => {
      const named = paneId ?? current
      if (named === undefined) return
      window.pterm.setWallPin(named, paneId)
      patchProject(projectId, { wallPin: paneId })
    },
    [patchProject],
  )

  /**
   * The cell's follow-active-pane flag.
   *
   * `visibleGroupIds` (`workspace.ts`'s `wallPinFor`) is what reads it: while
   * on, the cell shows the project's active pane instead of its pin, so this
   * write is what makes the picker's "Follow active pane" row do anything at
   * all.
   */
  const toggleWallFollow = useCallback(
    (projectId: string, follow: boolean) => {
      window.pterm.setWallFollow(projectId, follow)
      patchProject(projectId, { wallFollowActive: follow })
    },
    [patchProject],
  )

  /**
   * Pin the pane the keyboard is currently on to the active project's wall
   * slot. The palette's "Pin this pane to the wall" route to `pinWallPane`,
   * naming the active project and the active pane in the same way a click on
   * the picker's own row would, but from the keyboard rather than a cell that
   * has to already be on screen to click.
   */
  const pinActivePane = useCallback(() => {
    if (!state.activeProjectId || !activePaneId) return
    pinWallPane(state.activeProjectId, activePaneId, undefined)
  }, [state.activeProjectId, activePaneId, pinWallPane])

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
      window.pterm.setLayout(
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
        await Promise.all([window.pterm.restore(), window.pterm.notifications()])
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
      window.pterm.onStatus(({ tabId, state: tabState, since }) =>
        dispatch({ type: 'statusChanged', tabId, state: tabState, since }),
      ),
    [],
  )

  /*
   * A coarse clock for the elapsed labels.
   *
   * Fifteen seconds, not one. The labels are whole minutes, so a tick per
   * second would re-render every tab and sidebar row sixty times for each
   * change any of them can show. Fifteen means a label is at worst that stale,
   * which is invisible at minute resolution.
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])

  // The clocks for tabs that were already in a state before this window
  // existed. `restore` brings back the states; without this the labels would
  // all be blank until each tab's next transition, which for an idle session
  // could be hours.
  useEffect(() => {
    window.pterm
      .statusSince()
      .then((since) => dispatch({ type: 'statusSnapshot', status: state.status, since }))
      // Swallowed: a missing clock costs a label, not correctness.
      .catch(() => {})
    // Once, on mount. `state.status` is read rather than depended on, so a
    // status arriving later does not refetch every clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The one place that tells the main process what is selected, so every path
  // is covered — including the ones nothing calls directly, like a close or a
  // death moving the active tab to a neighbour.
  useEffect(() => {
    if (!ready) return
    window.pterm.setActive(currentTabId)
  }, [ready, currentTabId])

  const currentBrowserTabId = activeTabId(state, 'browser')
  // Gated like setActive above, for the same pairing: before restore
  // resolves, this region's answer is null, which is a statement about a
  // state the renderer does not know yet, not a considered "no selection".
  useEffect(() => {
    if (!ready) return
    window.pterm.setActiveBrowser(currentBrowserTabId)
  }, [ready, currentBrowserTabId])

  useEffect(() => {
    if (!ready) return
    window.pterm.setActiveProject(state.activeProjectId)
  }, [ready, state.activeProjectId])

  // A client stopping is not a session dying. `Ctrl-b d` inside a pane, and
  // the detach restore does before it reattaches, both arrive here with the
  // session still running, and those tabs must stay. What changes when the
  // session really has died is what happens next — the tab stays, marked
  // dead, instead of vanishing.
  useEffect(
    () =>
      window.pterm.onExit(({ id, code, sessionAlive, reason }) => {
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
      window.pterm.onFocusTab((tabId) => {
        const tab = state.panes.find((candidate) => candidate.id === tabId)
        if (!tab) return
        dispatch({ type: 'activatedProject', id: projectIdForTab(state.projects, tab) })
        dispatch({ type: 'activatedTab', id: tabId })
      }),
    [state.panes, state.projects],
  )

  /*
   * A browser pane an agent's MCP tool call asked main for, which main has
   * already written to config: this puts it on screen.
   *
   * `opened` alone, without the `activatedProject` its neighbour above
   * dispatches, and that is the difference between showing a pane and taking
   * the user somewhere. The pane still mounts either way: `BrowserColumn`
   * renders EVERY project's browser groups and hides the ones that are not
   * on screen with `visibility` (see its `panes` const), so the `<webview>`
   * attaches, reports its guest to main, and can be navigated even while the
   * user is looking at another project. Stealing the window for a tool call
   * a background session made would be the wrong trade.
   *
   * `[]`, unlike `onFocusTab` above: the descriptor arrives whole in the
   * event and nothing here reads `state`, so there is no stale closure to
   * avoid and no reason to resubscribe on every workspace change.
   */
  useEffect(
    () => window.pterm.onBrowserPaneOpened((tab) => dispatch({ type: 'opened', tab })),
    [],
  )

  // Pushed by main on its own schedule, not polled: see `onUpdateAvailable`'s
  // own comment in `shared/ipc.ts`.
  useEffect(() => window.pterm.onUpdateAvailable(setUpdate), [])

  // Once, at mount, and deliberately after main's startup migration has had
  // its turn: an install that only needed re-pointing is already repaired by
  // the time this asks, so the strip stays down for the case that fixed
  // itself. A read that throws — an unparseable settings.json — is not a
  // reason to warn about hooks; the settings pane is where that error belongs.
  useEffect(() => {
    window.pterm
      .hooksState()
      .then((state) => setHooksMissing(!state.installed))
      .catch(() => setHooksMissing(false))
  }, [])

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
      window.pterm
        .restartTab({ tab })
        .then((restarted) => dispatch({ type: 'opened', tab: restarted }))
        .catch(fail)
    },
    [fail],
  )

  const dismissTab = useCallback((id: string) => {
    window.pterm.dismissTab(id)
    dispatch({ type: 'dismissed', id })
  }, [])

  const renameTab = useCallback(
    (id: string, title: string) => {
      window.pterm
        .renameTab(id, title)
        .then((panes) => dispatch({ type: 'panesMerged', panes }))
        .catch(fail)
    },
    [fail],
  )

  // The open pane menu, with the viewport coordinates it is drawn at. Same
  // shape and same reasons as `TabBar`'s: see the long note there for why
  // these are coordinates and a `fixed` box rather than an absolutely
  // positioned child.
  const [paneMenu, setPaneMenu] = useState<{ id: string; left: number; top: number } | null>(null)

  useEffect(() => {
    if (paneMenu === null) return
    const close = (): void => setPaneMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [paneMenu])

  const recolorPane = useCallback(
    (id: string, color: PaneColor | null) => {
      window.pterm
        .setPaneColor(id, color)
        .then((panes) => dispatch({ type: 'panesMerged', panes }))
        .catch(fail)
    },
    [fail],
  )

  const muted = useCallback(
    (projectId: string) => (notifications ? projectMuted(notifications.rules, projectId) : false),
    [notifications],
  )

  const toggleMute = useCallback(
    (projectId: string) => {
      if (!notifications) return
      const rules = toggleProjectMute(notifications.rules, projectId)
      window.pterm.updateNotifications({ rules }).then(setNotifications).catch(fail)
    },
    [notifications, fail],
  )

  // A menu item the user clicked rather than reached by its accelerator. The
  // keystrokes deliberately never reach the menu (`registerAccelerator: false`
  // in main), which is why these actions live here and main can only ask for
  // them — and why clicking one used to do nothing at all.
  useEffect(
    () =>
      window.pterm.onMenuCommand((command) => {
        switch (command) {
          case 'newTab':
            openTab()
            return
          case 'closePane':
            // Same guard the ⌘W handler applies: with no pane there is nothing
            // to close, and requestClosePane(null) is not a thing to ask for.
            if (activePaneId) requestClosePane(activePaneId)
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
          case 'toggleFiles':
            toggleFiles()
            return
          case 'toggleTabs':
            toggleTabs()
            return
          case 'toggleSkills':
            toggleSkills()
            return
          case 'togglePresets':
            togglePresets()
            return
          case 'togglePrompts':
            togglePrompts()
            return
          case 'toggleNotes':
            toggleNotes()
            return
          case 'toggleGit':
            toggleGit()
            return
          case 'toggleIssues':
            toggleIssues()
            return
          case 'toggleTodos':
            toggleTodos()
            return
          case 'hideAllColumns':
            hideAllColumns()
            return
          case 'settings':
            setSettingsOpen(true)
            return
          case 'toggleWall':
            wallState.setOn(!wallState.on)
            return
          case 'wallColumns2':
            wallState.setColumns(2)
            return
          case 'wallColumns3':
            wallState.setColumns(3)
            return
          case 'wallColumns4':
            wallState.setColumns(4)
            return
          default: {
            // Same reasoning as `renderSlot`'s own `default`: assigning `command`
            // to `never` only typechecks once every member of `MenuCommand` has
            // a case above it, so a command added to the union without one
            // fails `tsc` on this line instead of doing nothing when clicked.
            const unreachable: never = command
            return unreachable
          }
        }
      }),
    [
      activePaneId,
      openTab,
      requestClosePane,
      splitActive,
      focusPane,
      toggleFiles,
      toggleTabs,
      toggleSkills,
      togglePresets,
      togglePrompts,
      toggleNotes,
      toggleGit,
      toggleIssues,
      toggleTodos,
      hideAllColumns,
      wallState.on,
      wallState.setOn,
      wallState.setColumns,
    ],
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
      // Closes in whichever region has focus, which is the one thing this
      // binding does differently from its neighbours: ⌘T above and ⌘S below
      // are the terminal region's whatever has focus, and ⌘W is not.
      if (event.code === 'KeyW' && !event.altKey) {
        const target = keyRegion === 'browser' ? currentBrowserTabId : activePaneId
        if (target) {
          event.preventDefault()
          requestClosePane(target)
        }
        return
      }
      // `saveEditorPane` is a no-op for a pane that is not an editor (or not
      // mounted at all), so this needs no check of the pane's kind: a ⌘S
      // typed at a terminal pane reaches here and does nothing.
      if (event.code === 'KeyS' && !event.altKey && activePaneId) {
        event.preventDefault()
        saveEditorPane(activePaneId).catch(fail)
        return
      }
      // Both here rather than as registered menu accelerators, for the reason
      // the whole File menu is unregistered: an accelerator the menu claims
      // never reaches the window, and these keystrokes are typed at panes
      // running Claude. ⇧ picks the axis, so `KeyD` covers both.
      if (event.code === 'KeyD' && !event.altKey) {
        event.preventDefault()
        // Terminal only. `splitActive` works off `activePaneId`, which is the
        // TERMINAL region's selection, so running it while the browser region
        // has focus would split a terminal pane the user is not looking at.
        // The `preventDefault` above is left unconditional, where it already
        // was, so this branch consumes ⌘D the same way in both regions rather
        // than letting the region decide what the event goes on to do.
        if (keyRegion === 'terminal') splitActive(event.shiftKey ? 'col' : 'row')
        return
      }
      // Below the `data-shortcuts="off"` guard at the top of this handler, so
      // it inherits that protection: ⌘K typed into the palette's own input is
      // the palette's, not a request to reopen it.
      if (event.code === 'KeyK' && !event.altKey) {
        event.preventDefault()
        setPaletteOpen((open) => !open)
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
      // ⌥⌘ + a letter, one per column. A sibling of the arrow branch above
      // rather than nested inside it: both test the same `altKey &&
      // !shiftKey` guard, and nesting one inside the other would make the
      // arrow branch's fallthrough (no direction matched) swallow these too.
      if (event.altKey && !event.shiftKey) {
        const column: Record<string, () => void> = {
          KeyF: toggleFiles,
          KeyS: toggleSkills,
          KeyP: togglePresets,
          KeyR: togglePrompts,
          KeyN: toggleNotes,
          KeyG: toggleGit,
          KeyI: toggleIssues,
          // No collision with ⌘T for a new tab: the `KeyT` branch above is
          // guarded on `!event.altKey`, and this whole map sits behind
          // `event.altKey`.
          KeyT: toggleTodos,
        }
        const toggle = column[event.code]
        if (toggle) {
          event.preventDefault()
          toggle()
          return
        }
      }
      if (event.code === 'Backslash' && event.shiftKey) {
        event.preventDefault()
        hideAllColumns()
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
        // The focused region's own strip. Both are grouped by `groupedTabs`
        // and both are what their bar draws, so ⌥⌘3 is the third row on screen
        // in whichever bar the user is working in. ⌘1-9 below is unaffected:
        // it selects a PROJECT, which both regions share.
        const strip = keyRegion === 'browser' ? browserTabEntries : tabEntries
        const target = strip[index]?.pane
        if (target) {
          event.preventDefault()
          dispatch({ type: 'activatedTab', id: target.id })
        }
        return
      }
      // This is already the wall's focus key, and deliberately has no wall
      // branch beside it: wall focus IS the active project (see `choosePane`),
      // so ⌘1-9 moves the outline and every project-scoped column with it by
      // dispatching exactly what it dispatched before the wall existed. A
      // project not on the wall is still selectable this way, which is right —
      // it is what the columns and a wall turned off would then show.
      const target = state.projects[index]
      if (target) {
        event.preventDefault()
        dispatch({ type: 'activatedProject', id: target.id })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    activePaneId,
    tabEntries,
    // The browser region's three inputs, beside the terminal's two above:
    // which strip ⌥⌘1-9 indexes, which pane ⌘W closes, and which of the two
    // regions both of those questions are about.
    browserTabEntries,
    currentBrowserTabId,
    keyRegion,
    state.projects,
    openTab,
    requestClosePane,
    splitActive,
    focusPane,
    fail,
    toggleFiles,
    toggleSkills,
    togglePresets,
    togglePrompts,
    toggleNotes,
    toggleGit,
    toggleIssues,
    toggleTodos,
    hideAllColumns,
  ])

  /**
   * Where an editor pane's file sits relative to its own project, or null when
   * it does not sit there: a pane with no `filePath`, a pane whose slug matches
   * no project row, or a path outside that project's `cwd`.
   *
   * The pane row stores an absolute path and `fsRead` takes a relative one, so
   * this is the conversion between them. The arithmetic is `relativeToProject`,
   * which has unit tests of its own; this is the project lookup that feeds it.
   * Both halves are here rather than inside `FileView` because vitest runs with
   * no DOM and cannot mount a component to reach them.
   */
  const editorRelPath = (pane: TabDescriptor): string | null => {
    if (!pane.filePath) return null
    const owner = projectIdForTab(state.projects, pane)
    const cwd = state.projects.find((candidate) => candidate.id === owner)?.cwd
    return cwd === undefined ? null : relativeToProject(cwd, pane.filePath)
  }

  // One row per PANE, not per tab, per the spec: a split tab holds two
  // sessions and both are switchable. `state.panes` is the same collection
  // `needsYou` ranks, so this list and Needs You cannot disagree about what a
  // session is.
  //
  // `severity` is the index into the shared SEVERITY order, so lower is worse.
  // An unreported pane sorts last among equally-matching panes rather than
  // first, which is why the fallback is the array length and not zero. Score
  // still outranks severity: a query match beats a worse-state pane that
  // didn't match as well.
  const paletteSessions: PaletteSession[] = state.panes.map((pane) => {
    const reported = state.status[pane.id]
    return {
      id: pane.id,
      name: tabLabel(pane),
      severity: reported ? SEVERITY.indexOf(reported) : SEVERITY.length,
    }
  })

  /**
   * Which project a group belongs to, a question only the wall asks: which cell
   * carries the focus outline, and which project a click in one focuses.
   *
   * `panes[0]` is safe because `paneGroups` never emits an empty group — it
   * `continue`s on one rather than pushing it — and `projectIdForTab` is the
   * route every other reader of a pane's project in this file takes.
   */
  const projectOfGroup = (group: PaneGroup): string =>
    projectIdForTab(state.projects, group.panes[0].pane)

  // Which slots have a pane in them, read off the groups rather than by asking
  // the pin rule a second time here: the placeholder then appears exactly where
  // no group was drawn, whatever the reason one was not.
  const filledSlots = new Set(groups.filter((group) => group.visible).map(projectOfGroup))

  // Cut, not rewritten, from the row it used to sit in directly: this is the
  // one slot `renderSlot` cannot build inline, since a fragment case that
  // returned it verbatim would be indistinguishable from the JSX it replaced.
  const terminalColumn = (
    // `data-testid` here rather than relying on `Terminal.tsx`'s own
    // `terminal` testid: that one only exists once a pane has spawned a real
    // pty, and a test that only needs this column's WIDTH (the row's one
    // `flex-1 min-w-0` item, and so the one that absorbs whatever the `gap`
    // helper's drop targets cost the row) should not have to spawn a tmux
    // session to ask for it.
    <div data-testid="terminal-column" className="flex min-w-0 flex-1 flex-col">
      {showsTabBar(collapsedColumns, hiddenColumns, wallState.on) ? (
        <TabBar
          tabs={tabEntries}
          activeId={currentTabId}
          status={state.status}
          since={state.since}
          now={now}
          dead={state.dead}
          dirty={dirty}
          onActivate={(id) => dispatch({ type: 'activatedTab', id })}
          onClose={requestClosePane}
          onRestart={restartTab}
          onDismiss={dismissTab}
          onNew={openTab}
          onRename={renameTab}
          onRecolor={recolorPane}
          onJoin={joinPanes}
          canJoin={canJoin}
          canOpen={canOpen}
          onOpenBrowser={openDevServer}
          canOpenBrowser={canOpenDevServer}
        />
      ) : null}
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
              //
              // That gap is also what draws the seam. This background is
              // painted, each pane paints `bg-bg` over its own box, and the
              // only place the colour survives is the one pixel between two
              // panes. Done here rather than on `PaneDivider` because the
              // strip is centred on a computed offset that misses the real
              // seam by up to `n − 1.5` pixels (its own comment measures
              // it), so a line drawn on the handle would sit beside the gap
              // on a lopsided three- or four-pane tab. The gap IS the seam.
              //
              // `bg-clip-content` so the colour stops at the content box.
              // A background paints the padding box by default, which would
              // turn the `p-2` frame into an 8px border around every tab
              // instead of a hairline between panes.
              'absolute flex gap-px bg-border bg-clip-content p-2',
              // No rect means the whole column, which is every group without a
              // wall and every HIDDEN group with one. That second half is the
              // load-bearing one: a hidden group is `invisible`, not
              // `display: none`, precisely so it keeps measuring itself, and
              // one measured at a cell's size would drive its tmux session to
              // that size while nobody is looking at it.
              group.rect ? '' : 'inset-0',
              // Room for the cell's header, which is drawn over this box by
              // `WallCell` and is opaque. Its own comment says the group's
              // `p-2` keeps the terminal clear of it; measured, it does not —
              // the header is 22px tall (24 with the waiting strip above it)
              // against 8px of padding, and the top two rows of every wall
              // terminal sat behind it. The pane box shrinking by 16px is the
              // right answer rather than a cost: the header IS part of the
              // cell, and a terminal measured at a box it does not really have
              // is the one thing this column must never hand tmux.
              group.rect ? 'pt-6' : '',
              group.visible ? 'visible z-10' : 'invisible z-0 pointer-events-none',
              // Which cell the keyboard and the columns are talking about, said
              // out loud. An outline rather than a border, for the reason the
              // active pane's ring gives below: it takes no space, so marking a
              // cell cannot resize it and set off a fit of the real session.
              group.rect &&
                projectOfGroup(group) === state.activeProjectId &&
                'outline outline-1 -outline-offset-1 outline-accent',
            )}
            style={{ ...group.style, ...group.rect }}
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
                onMouseDown={() => choosePane(box.pane)}
                // Right-click opens the colour menu. Nothing else in the
                // app listened for `contextmenu` on a pane, and xterm does
                // not take it either, so this claims a gesture that did
                // nothing rather than displacing one.
                onContextMenu={(event) => {
                  event.preventDefault()
                  choosePane(box.pane)
                  setPaneMenu({ id: box.pane.id, left: event.clientX, top: event.clientY })
                }}
                className={cn(
                  // `relative`: the dead-pane chrome below positions itself
                  // against this box, and an overlay that escaped to the
                  // group container would land on whichever pane happened to
                  // be at that corner.
                  //
                  // The background confines the container's seam colour to
                  // the gaps, and it is the PANE'S colour rather than a
                  // fixed `bg-bg` (see `style` below, which sets it). Both
                  // halves matter: xterm's fit leaves a sub-cell remainder
                  // at each edge, so a pane whose canvas is tinted and
                  // whose box is not wears a strip of the old background
                  // down one side and along the bottom.
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
                // `var(--color-bg)` rather than the default hex: an uncoloured
                // pane's box has to follow whatever canvas the theme is
                // painting, and the token already does that. A literal here
                // would leave the box on one palette's canvas while the
                // terminal drawn inside it moved to another.
                style={{ ...box.style, background: box.pane.color ?? 'var(--color-bg)' }}
              >
                {/* The pane's contents, by kind. Every pane was a terminal
                    until the editor slice; an editor or diff pane has no
                    session to attach and mounting one for it would create the
                    very tmux session the kind exists to do without.
                    A browser pane never reaches here: it belongs to the other
                    region, and `paneGroups` is asked for this one's panes. */}
                {box.pane.type === 'diff' ? (
                  <DiffView
                    projectId={projectIdForTab(state.projects, box.pane)}
                    // `diffRelPath` is repo-root-relative, set once by
                    // `openDiff` in main; `editorRelPath` is relative to
                    // the PROJECT cwd. The two agree only when the project
                    // IS the repository root, so a saved row that already
                    // carries `diffRelPath` is preferred and the derived
                    // path is only a fallback for one that predates it.
                    relPath={box.pane.diffRelPath ?? editorRelPath(box.pane)}
                    side={box.pane.diffSide ?? 'worktree'}
                    paneColor={box.pane.color}
                  />
                ) : box.pane.type === 'editor' ? (
                  <FileView
                    projectId={projectIdForTab(state.projects, box.pane)}
                    relPath={editorRelPath(box.pane)}
                    paneColor={box.pane.color}
                    theme={theme}
                    paneId={box.pane.id}
                    onDirtyChange={onDirtyChange}
                  />
                ) : (
                  <Terminal
                    tabId={box.pane.id}
                    // Passed undefined-able, deliberately. Resolving it here
                    // is what would stop an uncoloured pane following the
                    // theme: `xtermTheme` needs to see the absence to
                    // substitute the current canvas for it.
                    paneColor={box.pane.color}
                    theme={theme}
                    visible={group.visible}
                    // Never for a tab that is off screen: taking focus into one
                    // would move typing to a terminal the user cannot see.
                    focused={group.visible && box.pane.id === activePaneId}
                    onHistoryRequested={requestHistory}
                    pathLinks={pathLinks}
                  />
                )}
                {/* Inside the pane box, which is the whole point: it rises
                    from the bottom edge of the pane the Up was typed at,
                    not from the window. Only ever one at a time, and only
                    ever on the active pane: `requestHistory` sets this to
                    the pane that asked, and the effect beside it clears it
                    as soon as the selection moves elsewhere. */}
                {historyPane === box.pane.id ? (
                  <HistoryOverlay
                    entries={historyEntries}
                    scope={historyScope}
                    onScopeChange={setHistoryScope}
                    onDismiss={() => closeHistory(box.pane.id)}
                    // Typed, never submitted, on the same channel the
                    // skills and prompts columns insert with.
                    onPick={(cmd) => {
                      window.pterm.input(box.pane.id, cmd)
                      closeHistory(box.pane.id)
                    }}
                  />
                ) : null}
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
        {/* The wall's chrome, one box per SLOT rather than one per group.
            An empty slot is a real state — a project put on the wall before
            anything was pinned, or a pin whose pane has since gone — and its
            header's picker is the only place a pane can be chosen for it, so a
            slot that drew nothing would be a project on the wall that the wall
            never shows.

            Drawn after the groups, and positioned rather than laid out, for the
            reason `WallCell` gives: a header inside a group's flex layout would
            be one more item dividing the axis with the panes, which is not what
            it is. What keeps the terminal clear of it is the `pt-6` on a group
            with a rect, measured against the header's real height — NOT the
            `p-2` `WallCell`'s own comment credits, which is 8px against 22.

            `cellRect` with the same three arguments `paneGroups` passes, so a
            header and the terminal under it cannot disagree about where the
            cell is. */}
        {wallView
          ? wallState.slots.map((projectId, index) => {
              const cellProject = state.projects.find((entry) => entry.id === projectId)
              // Unreachable: `slotsFromStored` resolved this list against the
              // same projects. Here because `find` says it could happen.
              if (cellProject === undefined) return null
              // `wallPinFor`, not `cellProject.wallPin` directly: with follow
              // on, the terminal drawn in this cell (`visibleGroupIds`, same
              // function) is the project's active pane, and a header reading
              // the pin on its own would name a different pane than the one
              // showing, or none at all while the terminal shows one.
              const pin = wallPinFor(cellProject)
              // The region test is `visibleGroupIds`' own, so a pin naming a
              // browser pane reads as no pin here too rather than putting a
              // label on a cell that has no terminal in it.
              const pinned = state.panes.find(
                (entry) => entry.id === pin && regionOf(entry) === 'terminal',
              )
              return (
                <div
                  key={cellProject.id}
                  // `pointer-events-none` so this box is invisible to the mouse
                  // everywhere its header is not: what is under it is a live
                  // terminal, and clicks belong to that. `WallCell` opts its
                  // header and its picker back in.
                  className="pointer-events-none absolute"
                  style={cellRect(index, wallState.slots.length, wallState.columns)}
                >
                  {filledSlots.has(cellProject.id) ? null : (
                    <div
                      data-testid={`wall-empty-${cellProject.id}`}
                      // The group's own padding written again, so an empty cell
                      // frames exactly where its terminal would be — `top-6`
                      // included, which is the room the header takes.
                      className="absolute top-6 right-2 bottom-2 left-2 flex items-center justify-center border border-dashed border-border px-2 text-center text-[11px] text-faint"
                    >
                      {pin === null ? 'nothing pinned yet' : 'the pinned pane is gone'}
                    </div>
                  )}
                  <WallCell
                    project={cellProject}
                    pinned={pinned}
                    choices={tabsOfProject(state, cellProject.id, 'terminal')}
                    status={state.status}
                    since={state.since}
                    now={now}
                    focused={cellProject.id === state.activeProjectId}
                    onFocus={() => focusWallCell(cellProject.id, pinned?.id)}
                    onPin={(paneId) => pinWallPane(cellProject.id, paneId, pinned?.id)}
                    onToggleFollow={() =>
                      toggleWallFollow(cellProject.id, cellProject.wallFollowActive !== true)
                    }
                  />
                </div>
              )
            })
          : null}
      </div>
    </div>
  )

  // The case that draws each slot from `columnOrder`, held in state above.

  // `renderSlot` returns `ReactNode`, and `ReactNode` includes `undefined`:
  // with no `default` case, a slot this `switch` does not name simply falls
  // out of it and returns `undefined`, which is a value this function's own
  // return type accepts. `tsconfig.json` does not set `noImplicitReturns`
  // either, so nothing else catches that for a function shaped like this
  // one. The `default` below is what turns a missing case into a build
  // error: assigning `slot` to a `never` only typechecks once every member
  // of `ColumnSlot` has a case above it, so a slot the switch has not
  // handled fails `tsc` on this line instead of rendering a blank column.
  const renderSlot = (slot: ColumnSlot): ReactNode => {
    switch (slot) {
      case 'terminal':
        return terminalColumn
      case 'browser':
        // Membership is per project, visibility is a global column
        // preference, and the column is drawn only where both allow it:
        // `hiddenColumns.browser` false, and the ACTIVE project holding at
        // least one browser pane. Both are already spelled out once, in
        // `onScreenColumns.browser` above, and `hidden` takes it from there
        // rather than re-deriving it: `keyRegion` reads the same value, and a
        // second copy of the expression could be edited on one side only.
        // Neither condition takes the panes down.
        //
        // `hidden` rather than `null` is a deliberate trade, decided
        // 2026-08-11. `browserGroups` is EVERY project's browser panes, so
        // returning `null` here would destroy project A's `<webview>`s the
        // moment the user looked at project B, and rebuild them from their
        // saved URLs on the way back, losing scroll, history and any login.
        // What it costs is the other side of that: a project with no browser
        // panes of its own now keeps every other project's webviews alive
        // behind it, with their timers and sockets running. That is real
        // resource use, and it is accepted because those same webviews are
        // already alive whenever ANY browser pane is in view, so the choice
        // is not whether to run them but whether a project switch silently
        // destroys them.
        //
        // The one case that still renders nothing is no browser pane
        // anywhere in the workspace, where there is nothing to keep alive.
        return browserGroups.length === 0 ? null : (
          <BrowserColumn
            groups={browserGroups}
            tabs={browserTabEntries}
            activeId={currentBrowserTabId}
            projects={state.projects}
            hidden={onScreenColumns.browser}
            collapsed={browserCollapsed}
            onToggle={() => toggleColumnCollapsed('browser')}
            onDragStart={() => setDragging('browser')}
            onActivate={(id) => dispatch({ type: 'activatedTab', id })}
            onClose={requestClosePane}
            onNew={openBrowserPane}
            onRename={renameTab}
            onRecolor={recolorPane}
            // Not `canOpenSession`, which is what the terminal bar's `+`
            // reads: that asks whether a pty can be started here (a real
            // project, with its cwd still on disk), and a browser pane starts
            // no pty and never visits the cwd it records. `openBrowser` in
            // main needs the project ROW and nothing else, and the palette's
            // "New browser pane" reaches it on exactly those terms, so a
            // stricter gate here would leave one route to this action open
            // and the other greyed out.
            canOpen={project !== undefined}
            side={resizerSideFor(columnOrder, 'browser')}
          />
        )
      case 'projects':
        // Never derived: Projects does not move, so its side is a fact about
        // the column rather than something read off `columnOrder`.
        return (
          <Sidebar
            side="left"
            projects={state.projects}
            activeProjectId={state.activeProjectId}
            // Grouped, same as the bar: the sidebar draws the same panes in the
            // same window, and a split reading contiguous in one list and torn
            // apart in the other is the kind of thing a user notices at once.
            tabsOf={(id) =>
              groupedTabs(tabsOfProject(state, id, 'terminal'), state.tabs).map((entry) => entry.pane)
            }
            activeTabId={currentTabId}
            status={state.status}
            since={state.since}
            now={now}
            projectStateOf={(id) => stateOfProject(state, id)}
            needsYou={needsYou(state)}
            onSelectNeedy={(tab) => {
              dispatch({ type: 'activatedProject', id: projectIdForTab(state.projects, tab) })
              dispatch({ type: 'activatedTab', id: tab.id })
            }}
            onAcknowledgeNeedy={(tab) => window.pterm.acknowledgeTab(tab.id)}
            muted={muted}
            onToggleMute={toggleMute}
            onSelectProject={(id) => dispatch({ type: 'activatedProject', id })}
            onSelectTab={(id) => dispatch({ type: 'activatedTab', id })}
            inWall={(id) => wallState.slots.includes(id)}
            onToggleWall={(id) => wallState.toggleSlot(id)}
            onAdd={() => setAdding(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onMoveTab={(tabId, projectId) => {
              // Renames each pane's tmux session. A pane id is the other half of
              // the name it keeps, so every pane keeps its scrollback and
              // everything running in it. The reply lists every pane that moved —
              // one, until 2b lets a tab hold more.
              window.pterm
                .moveTabToProject(tabId, projectId)
                .then(({ projects, panes }) => dispatch({ type: 'movedTab', panes, projects }))
                .catch(fail)
            }}
            onRename={(id, name) => {
              window.pterm
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
              window.pterm
                .reorderProjects(order)
                .then((projects) => dispatch({ type: 'projects', projects }))
                .catch(fail)
            }}
            onRemove={(id) => {
              // The sessions keep running; they reappear under Unsorted, so a
              // relaunch is not needed to reach them again.
              window.pterm
                .removeProject(id)
                .then((projects) => dispatch({ type: 'projects', projects }))
                .catch(fail)
            }}
          />
        )
      case 'files':
        // Left of the sidebar, so the tree reads as the outermost thing and
        // gets the full window height.
        return hiddenColumns.files ? null : (
          <FilesPanel
            projectId={state.activeProjectId ?? undefined}
            onOpenFile={openFile}
            collapsed={filesCollapsed}
            onToggle={() => toggleColumnCollapsed('files')}
            onDragStart={() => setDragging('files')}
            side={resizerSideFor(columnOrder, 'files')}
          />
        )
      case 'tabs':
        return hiddenColumns.tabs ? null : (
          <TabsPanel
            nodes={tabTree(tabEntries.map((entry) => entry.pane), state.tabs)}
            activeId={activePaneId}
            status={state.status}
            since={state.since}
            now={now}
            dead={state.dead}
            collapsed={tabsCollapsed}
            onToggle={() => toggleColumnCollapsed('tabs')}
            onDragStart={() => setDragging('tabs')}
            onSelect={selectPane}
            onClose={requestClosePane}
            onRename={renameTab}
            // The same pair the terminal tab bar is given. That bar is hidden
            // while this column is open, so without these the gesture is
            // unreachable rather than merely elsewhere.
            onOpenBrowser={openDevServer}
            canOpenBrowser={canOpenDevServer}
            onJoin={joinPanes}
            canJoin={canJoin}
            side={resizerSideFor(columnOrder, 'tabs')}
          />
        )
      // Six independently collapsible columns (Files, above, is the
      // seventh). Each renders its own vertical strip when collapsed, so
      // none of them can vanish without leaving a way back.
      case 'skills':
        return hiddenColumns.skills ? null : (
          <SkillsPanel
            project={project}
            collapsed={skillsCollapsed}
            onToggle={() => toggleColumnCollapsed('skills')}
            onDragStart={() => setDragging('skills')}
            // No trailing `\r`: this types the invocation and leaves the user
            // to decide, per the spec. A submitted `/name` would run a skill
            // nobody had finished choosing.
            onInsert={(name) => {
              if (activePaneId) window.pterm.input(activePaneId, `/${name}`)
            }}
            side={resizerSideFor(columnOrder, 'skills')}
          />
        )
      case 'presets':
        return hiddenColumns.presets ? null : (
          <PresetsPanel
            project={project}
            collapsed={presetsCollapsed}
            onToggle={() => toggleColumnCollapsed('presets')}
            onDragStart={() => setDragging('presets')}
            onRun={(command, type) => launch(command, type)}
            side={resizerSideFor(columnOrder, 'presets')}
          />
        )
      case 'prompts':
        // Global, unlike every other column here: the prompts a user keeps
        // are ways of working rather than facts about a repository, so this
        // takes no project.
        return hiddenColumns.prompts ? null : (
          <PromptsPanel
            collapsed={promptsCollapsed}
            onToggle={() => toggleColumnCollapsed('prompts')}
            onDragStart={() => setDragging('prompts')}
            canInsert={activePaneId !== null}
            // Typed, never submitted, exactly like a skill. `input` is the same
            // channel the skills list uses.
            onInsert={(body) => {
              if (activePaneId) window.pterm.input(activePaneId, body)
            }}
            side={resizerSideFor(columnOrder, 'prompts')}
          />
        )
      case 'git':
        return hiddenColumns.git ? null : (
          <GitPanel
            project={project}
            collapsed={gitCollapsed}
            onToggle={() => toggleColumnCollapsed('git')}
            onDragStart={() => setDragging('git')}
            onOpenDiff={openDiff}
            side={resizerSideFor(columnOrder, 'git')}
          />
        )
      case 'issues':
        return hiddenColumns.issues ? null : (
          <IssuesPanel
            project={project}
            collapsed={issuesCollapsed}
            onToggle={() => toggleColumnCollapsed('issues')}
            onDragStart={() => setDragging('issues')}
            side={resizerSideFor(columnOrder, 'issues')}
          />
        )
      case 'todos':
        // Global, like `prompts`: a todo is the user's own list rather than a
        // fact about a repository, so this takes no project.
        return hiddenColumns.todos ? null : (
          <TodosPanel
            collapsed={todosCollapsed}
            onToggle={() => toggleColumnCollapsed('todos')}
            onDragStart={() => setDragging('todos')}
            side={resizerSideFor(columnOrder, 'todos')}
            creating={creatingTodo}
            onCreatingChange={setCreatingTodo}
          />
        )
      case 'notes':
        return hiddenColumns.notes ? null : (
          <NotesPanel
            project={project}
            collapsed={notesCollapsed}
            onToggle={() => toggleColumnCollapsed('notes')}
            onDragStart={() => setDragging('notes')}
            side={resizerSideFor(columnOrder, 'notes')}
          />
        )
      default: {
        const unreachable: never = slot
        return unreachable
      }
    }
  }

  /**
   * A drop target between two columns, or at either end of the row.
   *
   * Renders nothing outside a drag: with `dragging` null there is nothing to
   * drop, and a gap that existed all the time would sit in the flex row at
   * every moment the user is not dragging, taking width from the columns on
   * either side of it and eating the clicks that land on that sliver.
   *
   * While a drag IS in progress, the outer element still takes no space:
   * `w-0 shrink-0` is a zero-width flex item, so all of these that appear at
   * once cost the row nothing. `Terminal.tsx`'s `ResizeObserver` fires
   * `fit.fit()` and a real `window.pterm.resize` on any width change, and
   * before this the gaps' combined 4px each (`w-1`, no `--spacing`
   * override in `index.css`) came straight out of the terminal, the row's
   * only `flex-1` item: narrowing the live tmux session by several columns
   * on every drag, including one cancelled with Escape, and rewrapping
   * scrollback that the width coming back does not undo. The actual 4px hit
   * target lives on the CHILD instead, absolutely positioned against the
   * zero-width parent's edge (`-left-0.5` pulls it 2px left, `w-1` gives it
   * 4px, so it sits centred on the seam): the same trick `ColumnResizer`
   * already uses to hang a handle off a column's border without taking flex
   * space of its own. `z-20` keeps it above the neighbouring columns' own
   * content, which it now overlaps by 2px on each side rather than sitting
   * in space of its own.
   */
  const gap = (index: number): ReactNode =>
    dragging === null ? null : (
      <div key={`gap-${index}`} className="relative w-0 shrink-0">
        <div
          data-testid={`column-gap-${index}`}
          data-drop-index={index}
          onDragOver={(event) => {
            // Without this a drop never fires at all: an element that never
            // says it accepts the drag is not a valid drop target, by the
            // HTML5 drag-and-drop spec's own rule.
            event.preventDefault()
            setOver(index)
          }}
          onDragLeave={() => setOver((was) => (was === index ? null : was))}
          onDrop={(event) => {
            event.preventDefault()
            if (dragging !== null) moveColumnTo(dragging, index)
            setDragging(null)
            setOver(null)
          }}
          className={cn(
            'absolute inset-y-0 -left-0.5 z-20 w-1',
            over === index && 'bg-accent',
          )}
        />
      </div>
    )

  return (
    <div className="flex h-screen w-screen flex-col bg-bg">
      {/* Above the sidebar rather than beside it, so the strip spans the
          window and the traffic lights get a band that belongs to them. */}
      <TitleBar />

      {update ? (
        <UpdateBar
          info={update}
          onDownload={() => {
            void window.pterm.openExternal(update.url)
            setUpdate(null)
          }}
          onSkip={() => {
            void window.pterm.skipUpdate(update.version)
            setUpdate(null)
          }}
          onDismiss={() => setUpdate(null)}
        />
      ) : null}

      {hooksMissing ? (
        <HooksBar
          onInstall={() => {
            // Optimism would be wrong here: the install writes a file every
            // Claude session on the machine reads, and a failure must leave
            // the warning up rather than replace it with silence.
            void window.pterm
              .installHooks()
              .then((state) => setHooksMissing(!state.installed))
              .catch(() => setHooksMissing(true))
          }}
          onDismiss={() => setHooksMissing(false)}
        />
      ) : null}

      <div className="flex min-h-0 flex-1">
        {gap(0)}
        {columnOrder.map((slot, index) => (
          <Fragment key={slot}>
            {/* `display: contents`: this div carries `data-column-slot` for a
                test to find without adding a testid per panel, but it must
                not itself become a flex item, or the row would gain an extra
                box with no width or shrink rules of its own, sitting between
                two columns that do have them. `display: contents` takes the
                div out of layout entirely and lets its child (the panel's own
                flex item) take its place, so the row is exactly what it was
                before this wrapper existed. */}
            <div data-column-slot={slot} style={{ display: 'contents' }}>
              {renderSlot(slot)}
            </div>
            {gap(index + 1)}
          </Fragment>
        ))}

        {/* The pane's colour menu, rendered here rather than inside the pane
            box it belongs to. A hidden tab's container is `invisible`, and
            `visibility: hidden` inherits, so a menu that lived in a pane would
            be undrawable the moment its tab went to the background. It only
            ever opens on a visible pane today, which makes that theoretical,
            but the cost of being wrong is a menu nobody can see or click and
            the cost of avoiding it is where the element sits.

            `fixed`, so its place among these siblings (now after every
            column rather than between the terminal and Skills) affects
            neither layout nor stacking: `position: fixed` takes it out of
            the row's flex flow, and its own `z-30` already outranks
            everything else here regardless of DOM order. */}
        {paneMenu !== null ? (
          <div
            data-testid={`pmenu-${paneMenu.id}`}
            // Without this a click on the menu's own padding closes it through
            // the document listener before reaching a swatch.
            onClick={(event) => event.stopPropagation()}
            style={{ left: paneMenu.left, top: paneMenu.top }}
            className="fixed z-30 flex flex-col border border-border-strong bg-overlay py-0.5 text-[11px]"
          >
            {/* Terminal actions above the swatches, and only for a pane that
                has a terminal: an editor pane has no selection to copy and
                nothing to paste into, and offering it these would be four
                items that quietly do nothing.

                `selectionOf` is read at render, so Copy reflects the selection
                as it stood when the menu opened. That is the selection the
                right-click was made against — a right-click inside a pane does
                not clear it — so there is nothing later to re-read. */}
            {state.panes.find((pane) => pane.id === paneMenu.id)?.type === 'shell' ? (
              <>
                <button
                  data-testid={`pmenu-copy-${paneMenu.id}`}
                  disabled={selectionOf(paneMenu.id) === ''}
                  onClick={() => {
                    const text = selectionOf(paneMenu.id)
                    setPaneMenu(null)
                    if (text !== '') void window.pterm.clipboardWrite(text)
                  }}
                  className="cursor-default border-none bg-transparent px-2 py-1 text-left text-fg hover:bg-hover disabled:text-faint disabled:hover:bg-transparent"
                >
                  Copy
                </button>
                <button
                  data-testid={`pmenu-paste-${paneMenu.id}`}
                  onClick={() => {
                    const id = paneMenu.id
                    setPaneMenu(null)
                    // Written to the pty rather than into xterm: xterm has no
                    // way to send input it did not synthesise, which is the
                    // same reason Shift+Return goes out this way.
                    void window.pterm
                      .clipboardRead()
                      .then((text) => {
                        if (text !== '') window.pterm.input(id, text)
                      })
                      .catch(fail)
                  }}
                  className="cursor-default border-none bg-transparent px-2 py-1 text-left text-fg hover:bg-hover"
                >
                  Paste
                </button>
                <button
                  data-testid={`pmenu-clear-${paneMenu.id}`}
                  // Named for what it does. tmux keeps the deeper history and
                  // is untouched, and "Clear" alone reads as destroying it.
                  title="Clears this pane's scrollback. tmux keeps its own history."
                  onClick={() => {
                    const id = paneMenu.id
                    setPaneMenu(null)
                    clearTerminal(id)
                  }}
                  className="cursor-default border-none bg-transparent px-2 py-1 text-left text-fg hover:bg-hover"
                >
                  Clear scrollback
                </button>
                <div className="my-0.5 border-t border-border" />
                <button
                  data-testid={`pmenu-split-${paneMenu.id}`}
                  onClick={() => {
                    setPaneMenu(null)
                    splitActive('row')
                  }}
                  className="cursor-default border-none bg-transparent px-2 py-1 text-left text-fg hover:bg-hover"
                >
                  Split
                </button>
                <button
                  data-testid={`pmenu-close-${paneMenu.id}`}
                  onClick={() => {
                    const id = paneMenu.id
                    setPaneMenu(null)
                    // Through `requestClosePane`, not `closePane`: it is the
                    // one that asks first when a pane has unsaved work.
                    requestClosePane(id)
                  }}
                  className="cursor-default border-none bg-transparent px-2 py-1 text-left text-fg hover:bg-hover"
                >
                  Close pane
                </button>
                <div className="my-0.5 border-t border-border" />
              </>
            ) : null}
            <ColorSwatches
              paneId={paneMenu.id}
              selected={
                state.panes.find((pane) => pane.id === paneMenu.id)?.color ?? PANE_COLOR_DEFAULT
              }
              onPick={(color) => {
                setPaneMenu(null)
                recolorPane(paneMenu.id, color)
              }}
            />
          </div>
        ) : null}

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          sessions={paletteSessions}
          projectCwd={project?.cwd}
          projectId={project?.id}
          commands={[
            { name: 'Toggle Todos', run: toggleTodos },
            {
              name: 'New todo',
              // Shows the column as well as setting the flag: the column is
              // hidden on a fresh profile, and `renderSlot` never mounts
              // `TodosPanel` (and so never mounts its modal) while it is.
              run: () => {
                if (hiddenColumns.todos) toggleTodos()
                setCreatingTodo(true)
              },
            },
            { name: 'New browser pane', run: openBrowserPane },
            {
              name: wallState.on ? 'Turn the wall off' : 'Turn the wall on',
              run: () => wallState.setOn(!wallState.on),
            },
            // Gated on there being an active project and an active pane, the
            // way neighbouring commands gate on `canOpenSession`: there is no
            // project to add and no pane to pin without both.
            ...(project !== undefined && activePaneId
              ? [
                  {
                    name: 'Add this project to the wall',
                    run: () => wallState.toggleSlot(project.id),
                  },
                  { name: 'Pin this pane to the wall', run: pinActivePane },
                ]
              : []),
          ]}
          onOpenFile={openFile}
          onSelectSession={(id) => {
            const tab = state.panes.find((candidate) => candidate.id === id)
            if (!tab) return
            // The pane itself says which region it is in, because nothing else
            // here can. `paletteSessions` above maps EVERY pane, browser panes
            // included, and this list is reached from the keyboard over a
            // dialog portaled outside the browser column: the `pointerdown`
            // rule sees a target that is not in the column, and no focus
            // lands there either. Without this, picking a browser pane here
            // left ⌘W closing a terminal pane instead of the one just chosen.
            //
            // Not shared with `onSelectNeedy` below, which cannot reach this
            // case: `needsYou` filters on `canHaveSession`, and a browser pane
            // has no session, so that list is always the terminal region's.
            setActiveRegion(regionOf(tab))
            // The same two dispatches `onSelectNeedy` runs, in the same order.
            dispatch({ type: 'activatedProject', id: projectIdForTab(state.projects, tab) })
            dispatch({ type: 'activatedTab', id: tab.id })
          }}
          onInsert={(name) => {
            if (activePaneId) window.pterm.input(activePaneId, `/${name}`)
          }}
        />

        <AddProjectDialog
          open={adding}
          onOpenChange={setAdding}
          onAdd={(input) => {
            window.pterm
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
          theme={theme}
          onThemeChange={onThemeChange}
        />

        <ConfirmClosePane open={pendingClose !== null} onCancel={cancelClose} onDiscard={discardClose} />
      </div>

      {/* Below the columns rather than inside one, so it spans the window and
          belongs to the project as a whole rather than to any panel. */}
      <StatusBar projectId={state.activeProjectId ?? undefined} />
    </div>
  )
}

