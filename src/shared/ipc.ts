import type { TabState } from './status'
import type { PaneColor } from './paneColors'
import type { ThemeId } from './themes'

export type { TabState }

export const CHANNELS = {
  open: 'pterm:open',
  list: 'pterm:list',
  input: 'pterm:input',
  resize: 'pterm:resize',
  detach: 'pterm:detach',
  restore: 'pterm:restore',
  setActive: 'pterm:setActive',
  setActiveBrowser: 'pterm:setActiveBrowser',
  addProject: 'pterm:addProject',
  updateProject: 'pterm:updateProject',
  removeProject: 'pterm:removeProject',
  reorderProjects: 'pterm:reorderProjects',
  setActiveProject: 'pterm:setActiveProject',
  setWallPin: 'pterm:setWallPin',
  setWallFollow: 'pterm:setWallFollow',
  scanCandidates: 'pterm:scanCandidates',
  pickFolder: 'pterm:pickFolder',
  moveTabToProject: 'pterm:moveTabToProject',
  renameTab: 'pterm:renameTab',
  setPaneColor: 'pterm:setPaneColor',
  data: 'pterm:data',
  exit: 'pterm:exit',
  status: 'pterm:status',
  statusChanged: 'pterm:statusChanged',
  restartTab: 'pterm:restartTab',
  dismissTab: 'pterm:dismissTab',
  acknowledgeTab: 'pterm:acknowledgeTab',
  splitPane: 'pterm:splitPane',
  joinPane: 'pterm:joinPane',
  closePane: 'pterm:closePane',
  focusTab: 'pterm:focusTab',
  notifications: 'pterm:notifications',
  updateNotifications: 'pterm:updateNotifications',
  theme: 'pterm:theme',
  updateTheme: 'pterm:updateTheme',
  hooksState: 'pterm:hooksState',
  installHooks: 'pterm:installHooks',
  uninstallHooks: 'pterm:uninstallHooks',
  mcpBridgeState: 'pterm:mcpBridgeState',
  setMcpBridgeEnabled: 'pterm:setMcpBridgeEnabled',
  historyList: 'pterm:historyList',
  shellHistoryState: 'pterm:shellHistoryState',
  installShellHistory: 'pterm:installShellHistory',
  uninstallShellHistory: 'pterm:uninstallShellHistory',
  menuCommand: 'pterm:menuCommand',
  setLayout: 'pterm:setLayout',
  setPaneUrl: 'pterm:setPaneUrl',
  browserGuestAttached: 'pterm:browserGuestAttached',
  browserPaneOpened: 'pterm:browserPaneOpened',
  browserAgentActivity: 'pterm:browserAgentActivity',
  skills: 'pterm:skills',
  notesRead: 'pterm:notesRead',
  notesWrite: 'pterm:notesWrite',
  promptsList: 'pterm:promptsList',
  promptsAdd: 'pterm:promptsAdd',
  promptsRemove: 'pterm:promptsRemove',
  fsList: 'pterm:fsList',
  fsRead: 'pterm:fsRead',
  fsWrite: 'pterm:fsWrite',
  fsRename: 'pterm:fsRename',
  fsTrash: 'pterm:fsTrash',
  fsReveal: 'pterm:fsReveal',
  fsProbe: 'pterm:fsProbe',
  fsOpen: 'pterm:fsOpen',
  fsCopyPath: 'pterm:fsCopyPath',
  fsCreate: 'pterm:fsCreate',
  projectFiles: 'pterm:projectFiles',
  statusSince: 'pterm:statusSince',
  clipboardRead: 'pterm:clipboardRead',
  clipboardWrite: 'pterm:clipboardWrite',
  openEditor: 'pterm:openEditor',
  openBrowser: 'pterm:openBrowser',
  devServerUrl: 'pterm:devServerUrl',
  openExternal: 'pterm:openExternal',
  updateAvailable: 'pterm:updateAvailable',
  checkForUpdate: 'pterm:checkForUpdate',
  skipUpdate: 'pterm:skipUpdate',
  appVersion: 'pterm:appVersion',
  skippedVersion: 'pterm:skippedVersion',
  gitStatus: 'pterm:gitStatus',
  gitSync: 'pterm:gitSync',
  gitChanges: 'pterm:gitChanges',
  gitStage: 'pterm:gitStage',
  gitUnstage: 'pterm:gitUnstage',
  gitCommit: 'pterm:gitCommit',
  gitDiscard: 'pterm:gitDiscard',
  gitStash: 'pterm:gitStash',
  gitDiff: 'pterm:gitDiff',
  openDiff: 'pterm:openDiff',
  columnsVisible: 'pterm:columnsVisible',
  issuesList: 'pterm:issuesList',
  issuesGet: 'pterm:issuesGet',
  issuesCreate: 'pterm:issuesCreate',
  issuesEdit: 'pterm:issuesEdit',
  issuesSetState: 'pterm:issuesSetState',
  issuesComment: 'pterm:issuesComment',
  todosList: 'pterm:todosList',
  todosCreate: 'pterm:todosCreate',
  todosUpdate: 'pterm:todosUpdate',
  todosSetDone: 'pterm:todosSetDone',
  todosDelete: 'pterm:todosDelete',
  todosChanged: 'pterm:todosChanged',
} as const

/**
 * What a clicked menu item asks the renderer to do.
 *
 * The accelerators themselves stay unregistered (`registerAccelerator: false`)
 * so the keystroke still reaches the renderer's own handler rather than being
 * claimed by the menu — that part was always right. What was missing is that
 * *clicking* the item did nothing at all, because the renderer owns every one
 * of these actions and main had no way to ask for them.
 *
 * That is why the pane commands are here too. ⌘D, ⇧⌘D and the ⌘⌥arrows are
 * handled in the renderer's own keydown handler, beside ⌥⌘1; these values
 * exist so that CLICKING their menu items does the same thing. A registered
 * accelerator would take the keystroke off whatever is running in the pane,
 * which for this app is usually Claude.
 */
export type MenuCommand =
  | 'newTab'
  | 'closePane'
  | 'splitRight'
  | 'splitDown'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown'
  | 'toggleFiles'
  | 'toggleTabs'
  | 'toggleSkills'
  | 'togglePresets'
  | 'togglePrompts'
  | 'toggleNotes'
  | 'toggleGit'
  | 'toggleIssues'
  | 'toggleTodos'
  | 'hideAllColumns'
  | 'settings'

/**
 * What a tab was launched as.
 *
 * A declaration of intent, not a gate on status: it decides the launch command
 * and whether an expecting-hooks dot is drawn before any event has arrived.
 * Every tab carries PTERM_TAB_ID regardless, so a `claude` typed by hand into
 * a shell tab gets full status the moment its first hook lands. `editor`,
 * `diff` and `browser` are the exceptions: none of them has a launch command
 * at all.
 */
export type TabType = 'claude' | 'preset' | 'shell' | 'editor' | 'diff' | 'browser'

/**
 * Whether a pane of this kind has a tmux session behind it.
 *
 * The one place the kinds are divided that way, so the several things that
 * only make sense over a session (dying, being restarted, being counted as
 * blocking a human, being killed on close) all ask the same question. Written
 * as a predicate on the KIND rather than on `tmuxSession` being present,
 * because the answer has to hold for a pane whose session is temporarily
 * unknown: a `TabDescriptor` for a terminal reaches the renderer with its
 * session, but a `died` pane and a pane mid-restart are still terminals and
 * still restartable.
 *
 * Here rather than in `workspace.ts` so main can reach it too: `closePane` has
 * the same question to answer before it kills anything, and two spellings of
 * "is this a terminal" is how a pane comes to be killable on one side of the
 * IPC boundary and not the other.
 *
 * Three sessionless kinds now: `editor`, `diff` and `browser`. None of them
 * ever had a tmux session to attach, restart, or kill.
 */
const SESSIONLESS: readonly TabType[] = ['editor', 'diff', 'browser']

export function canHaveSession(pane: { type: TabType }): boolean {
  return !SESSIONLESS.includes(pane.type)
}

export type Region = 'terminal' | 'browser'

/**
 * Which column of the workspace a pane belongs to.
 *
 * Here rather than in `workspace.ts`, for the same reason `canHaveSession`
 * sits above it: main will need to ask the same question, deciding which
 * tab id counts as a project's active browser tab, and two spellings of "is
 * this a browser" is how the two sides come to disagree.
 *
 * Written as a predicate on `type` rather than on `canHaveSession`, because
 * `editor` and `diff` are sessionless too and stay in the terminal region;
 * `browser` is the only kind this design moves.
 */
export function regionOf(pane: { type: TabType }): Region {
  return pane.type === 'browser' ? 'browser' : 'terminal'
}

/** A notification rule, exactly as it is stored. */
export interface Rule {
  /** Absent matches every state. */
  on?: TabState
  /** Project id. Absent is global. */
  project?: string
  toast?: boolean
  /** A macOS system sound name, e.g. "Funk". Null is silence. */
  sound?: string | null
  urgency?: 'low' | 'high'
}

export interface NotificationConfig {
  rules: Rule[]
  /** Suppress a toast for the tab you are already looking at. */
  muteWhenFocused: boolean
  /** Honoured by the rules engine; no editor ships in M3. */
  quietHours: { from: string; to: string } | null
}

/**
 * What the settings pane needs to draw the hooks row, before and after the
 * install gesture. Declared here rather than in `src/main/hooks/install.ts`,
 * which now imports it, for the same reason `NotificationConfig` is: the
 * renderer reads this shape directly and cannot import from `src/main`.
 */
export interface HooksState {
  installed: boolean
  settingsPath: string
  hookPath: string
  /** The JSON that would be added, for the screen to show before it happens. */
  pending: string
  collisions: { event: string; command: string }[]
}

/**
 * What the settings pane needs to draw the browser bridge switch. Declared
 * here rather than in `src/main/mcp/enabled.ts`, which now imports it, for the
 * same reason `HooksState` is: the renderer reads this shape and cannot import
 * from `src/main`.
 *
 * `error` is not a rejected call. It is whatever the section has to tell the
 * user about a switch that otherwise worked, and it comes from both channels.
 * From `setMcpBridgeEnabled`: the two installers underneath it throw on a
 * `~/.claude.json` that cannot be read, and the switch catches that so it can
 * still do the half that does not depend on that file (stop serving), so what
 * it could not do arrives here. From `mcpBridgeState`: `enabled` is the stored
 * setting, and this says so when the socket that setting promises is not
 * actually accepting.
 */
export interface McpBridgeState {
  enabled: boolean
  error: string | null
}

/**
 * One command a `shell` pane ran, as the zsh preexec hook recorded it.
 *
 * Declared here rather than only in `src/main/shell/history.ts`, which now
 * imports and re-exports it, for the same reason `HooksState` is: the
 * overlay draws these and cannot import from `src/main`.
 */
export interface HistoryEntry {
  /** Epoch seconds, from the shell's own clock at the moment the command ran. */
  ts: number
  cwd: string
  /** The pane that ran the command, identified by its PTERM_TAB_ID. */
  tab: string
  cmd: string
}

/** `'project'` scopes to the current project's cwd; `'all'` does not. */
export type HistoryScope = 'project' | 'all'

/**
 * What the settings pane needs to draw the shell-history row, before and
 * after the install gesture. Declared here rather than in
 * `src/main/shell/install.ts`, which now imports it, for the same reason
 * `HooksState` is.
 */
export interface ShellHistoryState {
  installed: boolean
  rcPath: string
  scriptPath: string
  /**
   * Where the recorded commands are kept.
   *
   * Carried to the renderer so the Settings row can name it. Installing this
   * starts a permanent log of every command run in a shell pane, and a user
   * cannot decline something they were never told about; the row is the only
   * screen in the app where that decision is made.
   */
  historyFile: string
  /** The exact text an install would add, for the screen to show before it happens. */
  pending: string
}

/**
 * One row of a project's file tree.
 *
 * Declared here rather than only in `src/main/files/tree.ts`, which the
 * renderer cannot import from, for the reason `NotificationConfig` gives: the
 * renderer draws these.
 */
export interface FileEntry {
  name: string
  dir: boolean
}

/**
 * One file's text and the mtime it was read at.
 *
 * Declared here rather than only in `src/main/files/tree.ts` for the reason
 * `FileEntry` gives: the renderer draws this.
 */
export interface FileContents {
  text: string
  mtimeMs: number
}

/**
 * What a write did.
 *
 * Declared here rather than only in `src/main/files/tree.ts` for the reason
 * `FileContents` gives: the renderer draws this. A refusal is data, because
 * the pane says what happened instead of the app failing.
 */
export type WriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; reason: 'changed' | 'missing' | 'failed' }

export interface TabDescriptor {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  /**
   * Absent on an editor, diff or browser pane, none of which has a tmux
   * session at all. Present on every terminal pane, which is what `isPane`
   * still enforces per kind.
   */
  tmuxSession?: string
  type: TabType
  /** What the user called this tab. Absent until they name one. */
  title?: string
  /**
   * The pane's background, one of `PANE_COLORS`. Absent means `--color-bg`,
   * which is what every pane was before this field existed.
   */
  color?: PaneColor
  /**
   * The file an editor or diff pane is showing, absolute. Absent on every
   * terminal pane, and absent on an editor pane whose file could not be read.
   *
   * Absolute here and relative across `fsRead`: this is written by main and
   * read back by main, and never spelled by the renderer.
   */
  filePath?: string
  /**
   * Which side of the index a `diff` pane is showing. Absent on every other
   * kind, and on a `diff` row that predates the field, where the working tree
   * is the sensible reading.
   */
  diffSide?: DiffSide
  /**
   * The repo-relative path `gitDiff` needs, for a `diff` pane only.
   *
   * `filePath` above is resolved against the REPOSITORY root (see `openDiff`
   * in `register.ts`), but `editorRelPath` in `App.tsx` derives a path
   * relative to the PROJECT's cwd. Those two agree only when the project IS
   * the repository root. Carrying the original repo-relative path here, set
   * once at open time from the same string `gitChanges` reported, means the
   * renderer never has to re-derive it and never gets it wrong for a project
   * pointed at a subdirectory. Absent on a `diff` row that predates the
   * field, where `App.tsx` falls back to `editorRelPath`.
   */
  diffRelPath?: string
  /**
   * The page a `browser` pane is showing. Always the normalised, absolute
   * form: never what the user typed into the address bar. Two handlers create
   * a browser row and both always assign a string, so absent never happens
   * through either: `openBrowser`, which writes `about:blank` when the caller
   * names no URL, and `openAgentBrowserPane`, which always writes
   * `about:blank` because the tool call navigates the pane after creating it
   * (both in `main/ipc/register.ts`). `setPaneUrl`, the only other writer,
   * takes a required string and so cannot remove one either.
   * Still typed optional because `normalisePane` (`store.ts`) accepts
   * and keeps a browser row whose `url` a hand edit removed or left the wrong
   * type: config is a text file, not something only this app writes.
   * Absent on every other kind.
   */
  url?: string
  /**
   * The pane id of the Claude session that owns this browser pane, present
   * only on a browser pane an agent's MCP tool call created. Absent on a
   * browser pane the user opened by hand, which `browserPaneFor`
   * (`main/mcp/route.ts`) relies on: the decision from brainstorming is
   * that an agent drives its own browser pane, never the user's, and this
   * field is what that decision is keyed on. Absent on every other pane
   * kind too.
   *
   * Runtime only, deliberately: it means "an agent can act on this pane
   * right now", which stops being true the moment this process exits (the
   * session is gone and the MCP bridge's next socket is new). No `PaneRecord`
   * `main/ipc/register.ts` writes to `store.write` ever carries this field
   * (see `agentSessions` there, which is where the association actually
   * lives), so a relaunch always reattaches a browser pane with this absent,
   * never a confined pane owned by nobody.
   */
  agentSessionId?: string
}

export interface TabLayout {
  /** One axis per tab — never a tree. Ruled 2026-07-31; see the spec. */
  dir: 'row' | 'col'
  /** One entry per pane id in `kids`, summing to 1. */
  ratio: number[]
  kids: string[]
}

/**
 * A tab's layout, without any of the pane data it arranges.
 *
 * Declared here rather than only in `src/main/state/store.ts`, which now
 * imports it and re-exports it for its existing callers, because the
 * renderer needs to lay out a split and cannot import from `src/main` to get
 * the shape it lays out — the same reason `NotificationConfig` lives here.
 */
export interface TabRow {
  /**
   * The tab's permanent identity — the id of the pane that founded it, and
   * never rewritten afterwards.
   *
   * The renderer keys each tab's container on this (`App.tsx`), and
   * `Terminal.tsx` disposes the xterm on unmount, so changing it takes every
   * scrollback in the tab with it. That is why it is not the same field as
   * `groupId`: a tab whose panes have all died can only regain a tmux group by
   * naming it after whichever pane comes back first, and the one moment that
   * happens is the one moment every pane in the tab is a tombstone the user is
   * still reading.
   */
  id: string
  /**
   * The id half of the tmux group this tab is in NOW — `id` until every pane
   * of the tab has died at once and the tab re-founds, and then the id of the
   * pane that came back first.
   *
   * What restore matches a saved row by, because it is the only one of the two
   * live tmux can report: a tab is a `session_group`, and a group's name is
   * frozen at creation from the session it was created against. Every writer
   * inside one run works in `id` instead — that is what `SessionManager`
   * records per pane and what `withTabRow` replaces a row by.
   */
  groupId: string
  activePaneId: string | null
  layout: TabLayout
}

export interface OpenRequest {
  projectSlug: string
  cwd: string
  command?: string
  id?: string
  cols?: number
  rows?: number
  /** Defaults to 'shell' when absent. */
  type?: TabType
}

export interface DataEvent {
  id: string
  data: string
}

/**
 * Why a client stopped.
 *
 * `detached` and `killed` are the cases the app caused and therefore knows
 * the outcome of. `exited` is everything else, and says nothing on its own
 * about whether the tmux session survived — see `ExitEvent.sessionAlive`.
 *
 * Declared here, not only in `src/main/sessions/manager.ts`, because the
 * renderer needs to tell a deliberate `killed` apart from a genuine death too
 * — see `ExitEvent.reason`.
 */
export type ExitReason = 'detached' | 'killed' | 'exited'

export interface ExitEvent {
  id: string
  code: number
  /**
   * Whether the tmux SESSION is still running — not whether the client is.
   * A client stops for reasons that leave the session untouched (`Ctrl-b d`,
   * `tmux detach-client`, our own detach), so a consumer that treats every
   * exit as a death drops tabs whose work is still there.
   */
  sessionAlive: boolean
  /**
   * `killed` is a death the user asked for, not one to render as one: main
   * already exempts it from the registry tombstone for the same reason (see
   * `register.ts`'s exit handler), and the renderer must make the same
   * exemption or every ⌘W flashes as a crash and a fast click on the ↻ that
   * briefly appears can resurrect the very session just killed.
   */
  reason: ExitReason
}

export interface StatusEvent {
  tabId: string
  /** Null means the tab was forgotten — dismissed, or killed on purpose. */
  state: TabState | null
  /**
   * When the tab entered this state, epoch ms, for the elapsed label. Null
   * alongside a null state, and for a transition that carries no clock.
   */
  since: number | null
}

/**
 * The last thing an agent did to one browser pane, as the strip above that
 * pane reports it (`renderer/AgentStrip.tsx`).
 *
 * Two kinds because the two arrive from different places and mean opposite
 * things. `navigate` is sent by the MCP handler in `main/ipc/register.ts`, once
 * per `browser_navigate` that actually loaded a page. `blocked` is sent by
 * `refusesNonLoopback` in the same file, which is the one function both refusal
 * paths go through (the guest's navigation events, and `setWindowOpenHandler`
 * in `main/index.ts`), so the strip cannot learn about one kind of refusal and
 * miss the other.
 *
 * `origin` rather than the whole URL, and this is not a formatting choice: the
 * full text carries the query string and can carry embedded credentials, and
 * the page a confined pane sits on can provoke this as often as it likes by
 * looping `location.href`. See `refusesNonLoopback`, which is where the origin
 * is derived and where the same reasoning is written down for the stderr line.
 */
export type BrowserAgentActivity =
  | { paneId: string; kind: 'navigate'; url: string }
  | { paneId: string; kind: 'blocked'; origin: string }

/**
 * What Restart needs: the dead tab's record, plus the size to attach at.
 *
 * Deliberately does NOT carry the tab the pane belonged to, though main needs
 * it to put a split's pane back in its group. Main remembers that itself, from
 * when the pane was created or adopted (`SessionManager.tabWasIn`), because a
 * field for it could not be made safe: the cheapest value in scope at any call
 * site is the pane's own id, which type-checks, is correct for a one-pane tab
 * and for a split's founder, and is wrong for every other pane of a split —
 * and arrives here indistinguishable from a legitimate one-pane restart, so
 * nothing on this side could reject it. See finding I4.
 */
export interface RestartRequest {
  tab: TabDescriptor
  cols?: number
  rows?: number
}

/**
 * What splitting a pane needs: which pane to split beside, which way, and how
 * big the new pane will be drawn.
 *
 * `cols`/`rows` are REQUIRED, and that is the point of them. `SessionManager.
 * splitTab` defaults them to 80×24 and then resizes the new window to whatever
 * it ends up with, unconditionally — `open()`'s "no size given means do not
 * size the window" guard does not reach it. So an omitted size here is not
 * "leave it alone", it is "drive it to 80×24", which is the geometry defect
 * this codebase has shipped twice. Making them non-optional turns a caller that
 * has not measured into a compile error; `splitPane` refuses one at runtime too,
 * because a renderer can still measure zero.
 */
export interface SplitRequest {
  /** The pane the new one goes next to. Its tab is the tab they share. */
  paneId: string
  /**
   * The axis to arrange the tab along. Always honoured, including on a tab
   * that is already split: the split re-orients it.
   *
   * A ruling, not a consequence of one-axis-per-tab, and the second one here.
   * Until 2026-08-06 an already-split tab kept the axis it had and the new pane
   * joined it, which spared every pane in the tab a reflow and its tmux session
   * a resize for a split the user made elsewhere in the tab. That is a genuine
   * cost, now paid on purpose, because the alternative cost more: a tab that had
   * ever been split downward could not be split right again by any route, and
   * nothing said so, since the split did land — just not on the asked-for axis.
   * It reached real use as "split right is not working". See `splitPane`.
   */
  dir: 'row' | 'col'
  cols: number
  rows: number
}

/**
 * One tab, whole: every pane in it and the row that lays them out.
 *
 * What `splitPane` and `closePane` both answer with, rather than the one pane
 * that changed. The caller needs the new `kids` order and the redistributed
 * ratios anyway, and a renderer patching its own arrays from a partial reply is
 * a second place for tab membership to drift from what main just wrote.
 *
 * `tabs` holds at most one row — the tab that was split or closed into — and is
 * empty exactly when that tab has no panes left, which is also when `panes` is.
 * It is an array rather than a nullable row so that "the tab is gone" and "here
 * is the tab" are the same shape to iterate.
 *
 * `panes` is in `tabs[0].layout.kids` order, and is this tab's panes only —
 * never the whole workspace.
 */
export interface TabShape {
  panes: TabDescriptor[]
  tabs: TabRow[]
}

/**
 * Two tabs after a join: the target gains a pane, the source loses one.
 *
 * What `joinPane` answers with, carrying the two rows that changed. Unlike
 * `TabShape`, this must hold two rows because a join always affects both the
 * target tab (which gained a pane) and the source tab (which lost one).
 *
 * `dropped` names the source tab when it had no panes left after the join and
 * its row is gone, and is null when the source tab still holds panes.
 *
 * `panes` is every pane from both rows, in their layout order within each tab.
 * `tabs` carries the target row always, and the source row when it survives.
 * The target row is always first: the reducer that applies this shape reads
 * `tabs[0].activePaneId` to decide which pane gets focus, so the source row,
 * when present, must come second.
 */
export interface JoinShape {
  panes: TabDescriptor[]
  tabs: TabRow[]
  dropped: string | null
}

/**
 * The synthetic project collecting tabs whose slug matches no real one.
 * Lives here rather than in src/main because the renderer needs it too.
 */
export const UNSORTED_ID = 'unsorted'

/**
 * A user-defined preset, exactly as it is stored. Declared here rather than in
 * src/main/state/store.ts, which now imports it, because the renderer both
 * draws these and sends them back through `updateProject` — and cannot import
 * from src/main to do it.
 */
export interface Preset {
  id: string
  label: string
  command: string
}

export type TodoPriority = 'high' | 'medium' | 'low'

/**
 * One item on the global todo list.
 *
 * Global rather than per project: this is the user's own brain-dump, and the
 * Notes column is where per-project text lives. `id` is app-allocated and
 * never user text, the same rule `PromptEntry` follows.
 */
export interface TodoRecord {
  id: string
  /** Trimmed and non-empty. A create or update that would empty it is refused. */
  title: string
  /** Markdown. `''` for no body, never null. */
  body: string
  priority: TodoPriority
  done: boolean
  createdAt: string
  updatedAt: string
}

/** What the modal sends to create one: everything the user can type. */
export interface TodoDraft {
  title: string
  body: string
  priority: TodoPriority
}

/** Every field optional: an absent field keeps the stored value. */
export type TodoPatch = Partial<TodoDraft>

/**
 * A preset as the renderer sees it: user and repo presets already merged.
 * Declared here rather than in src/main/projects/manifest.ts, which now
 * imports it — two structurally identical types under two names is exactly
 * the drift restore.ts already avoids for TabDescriptor.
 */
export interface ResolvedPreset {
  id: string
  label: string
  command: string
  origin: 'user' | 'repo'
}

/**
 * Where a skill or command came from. Declared here rather than in
 * `src/main/skills/resolve.ts`, which now imports it, because the renderer
 * draws this tag and cannot import from `src/main` to get its shape — the
 * same reason `ResolvedPreset` and `NotificationConfig` live here.
 */
export type SkillOrigin = { kind: 'user' } | { kind: 'repo' } | { kind: 'plugin'; plugin: string }

/**
 * One row of the skills panel, and one action row of the command palette.
 *
 * `name` is the string a user would type, derived from where the entry lives
 * rather than from anything the file declares: a skill's directory name, a
 * command's path below its root with separators as `:`, and a `plugin:` prefix
 * on anything a plugin contributed. That is what Claude Code itself offers:
 * measured three ways, including `superpowers:brainstorming` rather than bare
 * and `gsd:reapply-patches` for a file declaring no name at all.
 *
 * A file's own `name:` is deliberately ignored: three skills on the author's
 * machine declare one that differs from their directory, and in every case
 * Claude Code uses the directory.
 */
export interface SkillEntry {
  /** What gets typed into a pane, without the leading slash. */
  name: string
  description: string
  kind: 'skill' | 'command'
  source: SkillOrigin
}

/**
 * One saved prompt, global to the app rather than owned by a project.
 *
 * Global because the prompts users keep are ways of working ("give me a
 * handover prompt for a fresh context window"), not facts about one
 * repository, and a per-project copy of each would be five copies to edit.
 *
 * `id` is minted by main (`randomUUID`), never by the renderer: it is the
 * handle a delete names, and two prompts sharing a label is ordinary.
 */
export interface PromptEntry {
  id: string
  /** What the row in the panel reads. */
  label: string
  /** The text typed into the active pane when the row is clicked. */
  body: string
}

export interface ProjectDescriptor {
  id: string
  name: string
  slug: string
  cwd: string
  presets: ResolvedPreset[]
  activeTabId: string | null
  /**
   * The project's active tab in the browser region, mirroring `activeTabId`
   * for the terminal region.
   *
   * Optional, unlike `activeTabId`: 40 files under `tests/` build a
   * `ProjectDescriptor` or `ProjectRecord` literal (grep -rln "activeTabId:"
   * tests/, 2026-08-11), and a required field would fail `tsc` in every one
   * of them for no behaviour change. A reader must spell the absence as
   * `?? null`.
   */
  activeBrowserTabId?: string | null
  /**
   * The pane this project shows in wall mode, or null for an empty slot.
   *
   * Optional for the same reason `activeBrowserTabId` is: `grep -rln
   * "activeTabId:" tests/` (2026-08-17) still matches 49 files building a
   * `ProjectDescriptor` or `ProjectRecord` literal, and a required field would
   * fail `tsc` in every one of them for no behaviour change. A reader must
   * spell the absence as `?? null`.
   */
  wallPin?: string | null
  /** Same optionality, same reason, as `wallPin`. A reader must spell the absence `=== true`. */
  wallFollowActive?: boolean
  /** False when `cwd` is no longer a directory — renamed or deleted. */
  available: boolean
}

/**
 * A directory that looks like a project and is not one yet. Declared here
 * rather than in src/main/projects/discovery.ts, which now imports it, because
 * the renderer draws the picker these fill.
 */
export interface Candidate {
  name: string
  cwd: string
  /** Which markers matched, so the picker can show why. */
  markers: string[]
}

export interface RestoreResult {
  /** Sidebar order. Unsorted, when present, is always last. */
  projects: ProjectDescriptor[]
  /** Every pane, flat. Which tab holds one is `tabs[].layout.kids`. */
  panes: TabDescriptor[]
  /**
   * Order, selection and layout — never existence. `restoreWorkspace` builds
   * this alongside `panes` and always has; this is only where the reply
   * stopped dropping it — see finding I5. Nothing downstream can lay out a
   * split without it.
   */
  tabs: TabRow[]
  activeProjectId: string | null
  /**
   * Every tab's state at the moment restore finished — including whatever a
   * spool replay just applied. Folded in here rather than left for a second,
   * separate `status()` call: that call raced `restore()`'s own multi-second
   * reconcile with no ordering guarantee between the two IPC round trips, and
   * the direction that loses blanks the board at every launch. One response
   * has no race to lose.
   */
  status: Record<string, TabState>
}

/** A release newer than the running app: the version to name, the page to open. */
export interface UpdateInfo {
  version: string
  url: string
}

/**
 * Why a check produced no bar, kept apart so Settings can say which.
 *
 * `failed` folds four unrelated nothings together (no network, rate limited,
 * an unreadable release tag, an unreadable running version) because the bar
 * treats them identically: it does not appear. The distinction that matters
 * to a user is `failed` against `current`, and that one is kept.
 */
export type UpdateStatus = 'available' | 'current' | 'skipped' | 'failed'

export interface UpdateCheckResult {
  status: UpdateStatus
  info: UpdateInfo | null
  message: string | null
}

/**
 * What the status bar knows about a project's checkout.
 *
 * `branch` and the counts are independently absent. A repository always has a
 * branch (or a detached HEAD, abbreviated); it has counts only once the branch
 * has an upstream to be counted against, which a freshly created branch does
 * not. The bar shows the branch either way and the sync control only when there
 * is something for it to sync with.
 *
 * `behind` is as old as the last fetch. Nothing here fetches on a timer, so it
 * moves when the user presses Sync and not before.
 */
export interface GitStatus {
  branch: string | null
  behind: number | null
  ahead: number | null
}

/** Whether a sync got all the way through, and git's own words if it did not. */
export type GitSyncResult = { ok: true } | { ok: false; error: string }

/** Which side of the index a diff is of. */
export type DiffSide = 'staged' | 'worktree'

/**
 * One path that differs from HEAD, from the index, or from both.
 *
 * `staged` and `worktree` are git's own status letters for that path (`M`,
 * `A`, `D`, `R`, `?` for untracked, `U` for unmerged), or null when that side
 * has nothing to say. A path modified in both the index and the worktree has
 * both set, and appears in both lists in `GitChanges`, which is what git
 * reports and what VS Code shows.
 */
export interface GitFileChange {
  path: string
  staged: string | null
  worktree: string | null
  /** Where a rename came from. Only ever set alongside a staged `R`. */
  renamedFrom?: string
}

/**
 * Everything the git column draws, from one `git status` run.
 *
 * `head` is the commit the working tree was read against, and exists so a
 * commit can refuse to run if the branch moved underneath it. It is null in a
 * repository with no commits yet, where nothing can have moved.
 *
 * `repo` is the last segment of the repository root, which is not always the
 * project's own name: a project can point at a subdirectory, and several
 * projects can share one checkout. The column names it so that what is about
 * to be committed to is on screen next to the branch.
 */
export interface GitChanges {
  repo: string
  branch: string | null
  head: string | null
  staged: GitFileChange[]
  unstaged: GitFileChange[]
}

/**
 * The answer to any mutating git channel.
 *
 * The new list travels with the answer rather than being fetched separately,
 * so the renderer replaces its state from the reply instead of patching its
 * own copy. `changes` is present on failure too, because a failed operation
 * still leaves a list worth drawing, and null only when the list itself could
 * not be read afterwards.
 */
export type GitMutation =
  | { ok: true; changes: GitChanges }
  | { ok: false; error: string; changes: GitChanges | null }

/** A label's name and colour, the only two fields the column draws. */
export interface IssueLabel {
  name: string
  color: string
}

/** A GitHub account, narrowed to the one field the column shows. */
export interface IssueUser {
  login: string
}

/** One comment on an issue, in the order `gh` returns them. */
export interface IssueComment {
  author: IssueUser
  body: string
  createdAt: string
}

export type IssueState = 'OPEN' | 'CLOSED'

/**
 * Why an issue closed, or null when it is open or closed for a reason not
 * in this list.
 *
 * `gh` reports an open issue's reason as the empty string, never `null`;
 * the parser maps both to `null` here, so nothing downstream can read
 * `stateReason !== null` as a stand-in for `state === 'CLOSED'`.
 */
export type IssueStateReason = 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | null

/**
 * One row of the issues list, narrowed to what the list row and the column
 * heading draw.
 *
 * `gh` sends more per label, assignee and author than this keeps (`id`,
 * `description`, `is_bot`, `name` among them); the extra fields are dropped
 * on the way in rather than carried through and ignored later.
 */
export interface IssueSummary {
  number: number
  title: string
  state: IssueState
  stateReason: IssueStateReason
  labels: IssueLabel[]
  assignees: IssueUser[]
  updatedAt: string
  author: IssueUser
}

/**
 * The full issue, for the detail modal.
 *
 * Extends `IssueSummary` rather than repeating its fields: a detail view is
 * a summary with the body and the full comment thread attached.
 */
export interface IssueDetail extends IssueSummary {
  body: string
  url: string
  createdAt: string
  /**
   * Only the detail carries a comment count, because only the detail fetches
   * comments. `gh issue list` offers no count scalar, so a per-row count would
   * mean pulling every comment body for every issue on every refetch.
   */
  commentCount: number
  comments: IssueComment[]
}

/**
 * The repository an issues result came from, for the column heading.
 *
 * `slug` is `owner/name`, for display. `arg` is what `repoArg` produced and
 * what every `gh` call passes to `--repo`. Kept apart because the two differ
 * on Enterprise hosts, and the heading has no reason to show the host.
 */
export interface IssueRepo {
  slug: string
  arg: string
}

/**
 * The answer to any issues read, in the same shape as `GitMutation`:
 * success carries the repository the answer came from alongside the value,
 * failure carries a reason the renderer can branch on plus a message it can
 * just show.
 */
export type IssuesResult<T> =
  | { ok: true; repo: IssueRepo; value: T; truncated: boolean }
  | { ok: false; reason: IssuesFailure; message: string }

export type IssueStateFilter = 'open' | 'closed' | 'all'

/**
 * Every way listing or reading issues can fail, named rather than left as a
 * string so the renderer can show a specific empty state for each one.
 *
 * Declared here rather than in `src/main/gh/run.ts`, which imports and
 * re-exports it, because the renderer cannot import from `src/main`.
 */
export type IssuesFailure =
  | 'no-project'
  | 'no-repo'
  | 'no-remote'
  | 'not-github'
  | 'no-gh'
  | 'no-auth'
  | 'no-issues'
  | 'failed'

/**
 * What a mutating file tree call answers.
 *
 * A message rather than a boolean, because every refusal here is something the
 * user typed or clicked and can act on: a name that is already taken, a file
 * another process removed. The renderer shows it and leaves the row alone.
 */
export type FsResult = { ok: true } | { ok: false; error: string }

/**
 * A project's files, for the palette's fuzzy open.
 *
 * `truncated` is surfaced rather than swallowed: a repo over the cap should
 * look like a palette missing files, not like a project without them.
 */
export interface ProjectFileList {
  files: string[]
  truncated: boolean
}

export interface PTermApi {
  open(request: OpenRequest): Promise<TabDescriptor>
  list(): Promise<TabDescriptor[]>
  /** Reattach tabs persisted by the previous run; returns what came back. */
  restore(): Promise<RestoreResult>
  setActive(id: string | null): void
  /**
   * Same shape as `setActive`, for the browser region's own selection, and a
   * separate channel rather than a parameter on `setActive` because the two
   * do not share a job: `setActive` also drives `onActiveTabChanged`, which
   * the status router reads to decide whether a pane is attended, so routing
   * a browser click through it would fire a notification for a terminal
   * that is simply visible beside the page.
   */
  setActiveBrowser(id: string | null): void
  /**
   * Every project mutation resolves to the whole list the sidebar should draw,
   * Unsorted included — built by the same code path restore uses, so a mutation
   * and a relaunch can never disagree about what the workspace looks like.
   */
  addProject(input: { name: string; cwd: string }): Promise<ProjectDescriptor[]>
  updateProject(
    id: string,
    patch: { name?: string; presets?: Preset[] },
  ): Promise<ProjectDescriptor[]>
  removeProject(id: string): Promise<ProjectDescriptor[]>
  reorderProjects(ids: string[]): Promise<ProjectDescriptor[]>
  setActiveProject(id: string | null): void
  /**
   * Fire and forget, like `setActiveProject`: the renderer has already drawn
   * the wall from its own state, and this exists only so the next launch
   * agrees. A failed write costs a pin, not a session.
   *
   * Keyed by PANE, not by project: the pane names its owner, and a pin on a
   * project that does not hold the pane means nothing.
   */
  setWallPin(paneId: string, pin: string | null): void
  setWallFollow(projectId: string, follow: boolean): void
  scanCandidates(): Promise<Candidate[]>
  /** The chosen folder, or null when the user cancelled. */
  pickFolder(): Promise<string | null>
  /**
   * Moves the tab by renaming the tmux session of every pane in it; everything
   * running inside them keeps running.
   *
   * `panes` is every pane that moved, never one: a pane's project membership
   * lives in its own session name, so a split tab has as many renames — and as
   * many updated records — as it has panes. Non-empty whenever this resolves,
   * because a tab with no panes is a move that throws.
   */
  moveTabToProject(
    tabId: string,
    projectId: string,
  ): Promise<{ projects: ProjectDescriptor[]; panes: TabDescriptor[] }>
  /**
   * Name a tab, or clear its name with an empty string.
   *
   * Resolves to every pane, like every other mutation here: the renderer
   * replaces its list from one authoritative reply rather than patching one
   * entry and hoping the rest still agree.
   */
  renameTab(id: string, title: string): Promise<TabDescriptor[]>
  /**
   * Resolves to the whole pane list, like `renameTab`: a colour changes one
   * row, and the renderer replacing its list wholesale is what keeps the
   * reply from being a second source of truth about the others.
   */
  setPaneColor(id: string, color: PaneColor | null): Promise<TabDescriptor[]>
  input(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  detach(id: string): void
  onData(listener: (event: DataEvent) => void): () => void
  onExit(listener: (event: ExitEvent) => void): () => void
  /** Every tab's state, for a renderer that has just mounted or reloaded. */
  status(): Promise<Record<string, TabState>>
  onStatus(listener: (event: StatusEvent) => void): () => void
  /** Recreate a dead tab's session under the same id, cwd, command and type. */
  restartTab(request: RestartRequest): Promise<TabDescriptor>
  /** Stop tracking a dead tab: the renderer has dropped its tombstone. */
  dismissTab(id: string): void
  /**
   * Mark a tab actioned: `waiting` becomes `idle`, `crashed` becomes `ended`.
   *
   * Fire and forget. The new state arrives back through `onStatus` like every
   * other state change, so the renderer never has to hold an opinion of its
   * own about what it just asked for.
   */
  acknowledgeTab(id: string): void
  /**
   * Add a pane to the tab that already holds `request.paneId`, beside it.
   *
   * Resolves to the whole tab — see `TabShape` — because the new pane's `kids`
   * position and the tab's new ratios are as much of the answer as the pane
   * itself. Rejects when no size was measured; see `SplitRequest`.
   */
  splitPane(request: SplitRequest): Promise<TabShape>
  /**
   * Join one pane to another's tab, moving it beside the target pane.
   *
   * Resolves to both affected rows and their panes, because a join always
   * changes two tabs: the target gains a pane and the source loses one.
   * The source tab's row is absent when it had no panes left.
   */
  joinPane(paneId: string, targetPaneId: string): Promise<JoinShape>
  /**
   * Kill one pane and take it out of its tab's layout.
   *
   * The session, its window and its saved row all go; the tab's remaining panes
   * share out the closed one's ratio. Closing the last pane of a tab closes the
   * tab, and resolves with both arrays empty.
   *
   * The only way to close anything: ⌘W, the tab bar's ×, and a clicked Close
   * Pane all come here. A second channel that killed a pane without touching
   * its tab row was where the layout drifted from what was on screen.
   */
  closePane(paneId: string): Promise<TabShape>
  /** A clicked toast asking the renderer to select a particular tab. */
  onFocusTab(listener: (tabId: string) => void): () => void
  /** A menu item the user *clicked*, rather than reached by its accelerator. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
  /** The stored notification rules, for the sidebar's per-project mute toggle. */
  notifications(): Promise<NotificationConfig>
  /** Merges `patch` into the stored notification config and returns the result. */
  updateNotifications(patch: Partial<NotificationConfig>): Promise<NotificationConfig>
  /** The stored theme id. */
  theme(): Promise<ThemeId>
  /** Stores `id` and returns what was stored. */
  updateTheme(id: ThemeId): Promise<ThemeId>
  /** Whether pTerm's hooks are installed, and what installing would add. */
  hooksState(): Promise<HooksState>
  /** Writes a timestamped backup, then merges pTerm's hooks into settings.json. */
  installHooks(): Promise<HooksState>
  /** Removes only pTerm's own hook groups, restoring the file it found. */
  uninstallHooks(): Promise<HooksState>
  /**
   * Whether the browser bridge is on, as the user last decided. Defaults to
   * on. Carries a note when the setting says on and the socket is not
   * accepting, which is the one way this screen could otherwise be wrong.
   */
  mcpBridgeState(): Promise<McpBridgeState>
  /**
   * Turns the browser bridge on or off, and applies it to the running app: on
   * writes the bridge script, registers the entry in `~/.claude.json` and
   * binds the unix socket; off removes the entry and stops the socket
   * accepting, which is what actually denies a session that registered a
   * bridge of its own. Both take effect without a relaunch.
   *
   * Never rejects. A `~/.claude.json` that cannot be read comes back in the
   * state's `error` rather than as a failed call, because stopping the server
   * does not depend on that file and must not be lost with it.
   */
  setMcpBridgeEnabled(enabled: boolean): Promise<McpBridgeState>
  /**
   * Past commands a `shell` pane ran, newest first, scoped to `projectCwd`
   * (`'project'`) or across every project (`'all'`).
   *
   * Read fresh on each call, like `hooksState`: the history file is
   * appended to by a live shell the whole time an overlay might be open.
   */
  historyList(projectCwd: string, scope: HistoryScope): Promise<HistoryEntry[]>
  /** Whether pTerm's shell-history hook is installed, and what installing would add. */
  shellHistoryState(): Promise<ShellHistoryState>
  /** Writes the snippet and merges it into `~/.zshrc`. */
  installShellHistory(): Promise<ShellHistoryState>
  /** Removes only pTerm's own marker block, restoring the file it found. */
  uninstallShellHistory(): Promise<ShellHistoryState>
  /**
   * Every skill and command available to the project at `projectCwd`.
   *
   * Read fresh on each call rather than cached: the panel and the palette
   * both call this on open, and a skill written a minute ago should be there.
   */
  skills(projectCwd: string): Promise<SkillEntry[]>
  /** The whole global todo list. */
  todosList(): Promise<TodoRecord[]>
  /**
   * Resolves with the todo list as it now stands. A refused create (empty
   * title) resolves with the list unchanged rather than rejecting.
   */
  todosCreate(draft: TodoDraft): Promise<TodoRecord[]>
  /** An unknown id is a no-op: resolves with the list unchanged rather than rejecting. */
  todosUpdate(id: string, patch: TodoPatch): Promise<TodoRecord[]>
  /** An unknown id is a no-op: resolves with the list unchanged rather than rejecting. */
  todosSetDone(id: string, done: boolean): Promise<TodoRecord[]>
  /** An unknown id is a no-op: resolves with the list unchanged rather than rejecting. */
  todosDelete(id: string): Promise<TodoRecord[]>
  /** Pushed to every window after any mutation, the originator included. */
  onTodosChanged(listener: (todos: TodoRecord[]) => void): () => void
  /** The project's note text, `''` when none has been written. */
  notesRead(projectId: string): Promise<string>
  /**
   * Overwrite the project's note. Atomic on disk; the renderer treats it as
   * fire-and-forget and swallows a rejection, since the text is still on
   * screen and this panel is not where transport faults get reported.
   */
  notesWrite(projectId: string, text: string): Promise<void>
  /** Every saved prompt, oldest first. Resolves to `[]` when none are saved. */
  promptsList(): Promise<PromptEntry[]>
  /**
   * Save a prompt and resolve to the whole list as it now stands on disk.
   *
   * The list rather than the new entry, so the panel replaces its state with
   * what was written instead of guessing where the entry landed.
   */
  promptsAdd(label: string, body: string): Promise<PromptEntry[]>
  /** Delete one prompt by id and resolve to what is left. Unknown ids are a no-op. */
  promptsRemove(id: string): Promise<PromptEntry[]>
  /**
   * Persist a tab's ratios after a drag. Fire-and-forget: the renderer already
   * has the layout on screen, and a failed write costs a ratio, not a session.
   *
   * `shares` is one fraction per pane the renderer draws in this tab, keyed
   * by pane id — every live kid AND every tombstone — as a fraction of the
   * WHOLE tab, summing to 1. Named rather than positional so that a tab
   * holding a tombstone, whose renderer-side `kids` is a permanent superset
   * of main's saved row, cannot be pairing its shares with the wrong panes:
   * main routes each share to the pane it names, not to a position in an
   * array.
   *
   * Sent ONCE, on pointer release. Ratios live in renderer state during the
   * gesture — throttled writes would push several a second through a queue
   * shared with restore and the exit handler.
   */
  setLayout(tabId: string, shares: Record<string, number>): void
  /**
   * Persist a browser pane's current page, fire-and-forget, mirroring
   * `setLayout` above: the renderer already shows the address it navigated
   * to, and a failed write costs a relaunch, not this session.
   *
   * Sent debounced from `BrowserPane`, not once per navigation event: a
   * page that redirects several times on one load would otherwise thrash
   * `config.json` for a URL only the last hop is worth remembering.
   */
  setPaneUrl(paneId: string, url: string): void
  /**
   * Say which guest `webContents` a browser pane's `<webview>` just attached,
   * so main can hold that pane to loopback origins while an agent owns it.
   *
   * Main cannot work the association out on its own. A guest's `webContents`
   * carries no pane id; `will-attach-webview` (`main/index.ts`) is handed the
   * `<webview>`'s own attributes and Electron's computed preferences, and no
   * pane id is among them; and `webContents.getAllWebContents()` answers with
   * every guest in the app at once, which is not an answer about one pane.
   * The renderer is the only side holding both halves, so it is the side that
   * says so.
   *
   * Fire-and-forget, like `setLayout` and `setPaneUrl` above: nothing in the
   * renderer waits on this, and a browser pane the user opened by hand sends
   * it too. Ownership is main's question, asked at the moment a navigation
   * starts, not something the renderer asserts here.
   */
  browserGuestAttached(paneId: string, guestId: number): void
  /**
   * A browser pane main opened by itself, for an agent's MCP tool call.
   *
   * The only pane in this app the renderer does not ask for. Every other one
   * is opened by a renderer call that gets its descriptor back
   * (`openBrowser`, `openEditor`, `open`), because the user asked for it
   * there; this one is asked for by a Claude session over a unix socket, and
   * main has already written the pane to config by the time the renderer
   * hears about it. The renderer's job is to put it on screen, which is also
   * what mounts the `<webview>` main then navigates.
   *
   * The descriptor carries `agentSessionId`, which is what keeps the
   * renderer's mirror of the association (`withAgentSessionsCleared` in
   * `workspace.ts`) in step with main's `agentSessions` map. Main sets its
   * own entry before this is sent, never after: the pane must be owned
   * before it is mounted, or the gap would be a browser pane an agent had
   * asked for that nothing was confining yet.
   */
  onBrowserPaneOpened(listener: (tab: TabDescriptor) => void): () => void
  /**
   * What an agent last did to one of its browser panes, for the strip that
   * pane draws (`renderer/AgentStrip.tsx`).
   *
   * Every browser pane's events come down this one channel, named by
   * `paneId`, and each strip filters for its own: a per-pane channel would
   * need main to know which panes have a listener, and the renderer already
   * knows which pane it is.
   *
   * Nothing replays. A strip that mounts after an event has been sent has
   * missed it for good, and two things are what make that sound rather than
   * lossy. The pane is created and mounted before the tool call that navigates
   * it can finish (see `openAgentBrowserPane` and `guestForPane` in
   * `main/ipc/register.ts`, which waits for the guest the mount attaches), so
   * the first event cannot outrun the first strip. And a strip comes off a
   * pane that is still on screen in exactly one case, which is not a case
   * where an event can still arrive: `withAgentSessionsCleared`
   * (`renderer/workspace.ts`) drops the flag when the OWNING SESSION's pane
   * leaves `state.panes`. Two live actions do that, and they are not alike.
   * `'closedPane'` is dispatched inside the `.then` of `closePane`'s invoke
   * (`App.tsx`), so main has already released ownership and nothing is left to
   * send. `'dismissed'` is not: `dismissTab` is an `ipcRenderer.send`
   * (`preload/index.ts`) and `App.tsx` dispatches on the next line without
   * waiting, so the renderer can drop the flag before main has run
   * `releaseAgentSession`. What that costs is one strip line for an event
   * arriving in that window, on a pane whose owning session has just gone;
   * what it is not is a pane left unconfined, because confinement reads main's
   * map rather than this flag. Short of that, `BrowserColumn` hides panes
   * rather than unmounting
   * them, and a reply that is silent about `agentSessionId` is kept from
   * clearing it by `panesMerged` (`renderer/workspace.ts`). That last one is
   * not a hypothetical: it is where a rename anywhere in the app used to take
   * the strip off every agent-owned pane.
   *
   * One exception, stated rather than left to be found: a renderer reload (⌘R)
   * rebuilds the whole window, this strip and its pane's `<webview>` included.
   * Whether the strip comes back depends on the owning session, because
   * `CHANNELS.restore`'s reply carries the runtime owner through
   * `agentOwnersOf` (`main/ipc/register.ts`), which skips an owner that is not
   * itself in the pane list it is mapping. A session still in the tab bar gets
   * its strip drawn again; one that has exited does not, which is the whole
   * point of that check. Either way the line is empty until the next call or
   * refusal, and whatever was on it before is gone. The stderr line in
   * `refusesNonLoopback` is the record that keeps.
   */
  onBrowserAgentActivity(listener: (event: BrowserAgentActivity) => void): () => void
  /**
   * One directory of one project, directories first then files.
   *
   * `relPath` is relative to the project's own `cwd` and is resolved against
   * it in main: no absolute path crosses this boundary. A path that would
   * leave the project, or a directory that cannot be read, resolves to an
   * empty list rather than rejecting.
   */
  fsList(projectId: string, relPath: string): Promise<FileEntry[]>
  /**
   * One file of one project, or null if it cannot be read.
   *
   * `relPath` is relative to the project's own `cwd` and is resolved against
   * it in main: no absolute path crosses this boundary. A path that would
   * leave the project, a directory, and a missing file all resolve to null
   * rather than rejecting.
   */
  fsRead(projectId: string, relPath: string): Promise<FileContents | null>
  /**
   * Which of `relPaths` name a readable regular file inside the project.
   *
   * The gate on terminal path links: `terminalPaths.ts` recognises SHAPES,
   * permissively and on purpose, and this is what decides which of them are
   * underlined. Without it every `e.g` in a paragraph would be a link that
   * reports an error when clicked, which is the enabled-control-that-fails
   * shape this app already has two of.
   *
   * Answers a subset of the input, in the input's order, so a caller can
   * compare by identity. Batched because the caller asks per hovered line and
   * a line can hold several: one round trip a line, not one a candidate. A
   * directory is NOT a file here (nothing can open one), and a path that would
   * leave the project is simply absent from the answer rather than an error:
   * the caller's next step is to draw a link or not, and it treats every
   * reason the same.
   *
   * `relPath` is relative and resolved in main, like `fsRead`: no absolute
   * path crosses this boundary.
   */
  fsProbe(projectId: string, relPaths: string[]): Promise<string[]>
  /**
   * Hand one file of one project to the system, the way double-clicking it in
   * Finder would.
   *
   * For the files the editor pane cannot show: an image, a pdf, an archive.
   * `opensInEditor` in `terminalPaths.ts` is what routes a click here rather
   * than to `openEditor`.
   *
   * Deliberately NOT reachable through `openExternal`, which refuses anything
   * that is not http(s) precisely so that the renderer cannot ask the system
   * to open a local file by naming a `file:` url. This channel is that
   * capability, given its own name and its own containment check, so that
   * allowing it here does not widen that one.
   *
   * Answers false for an unknown project, a path that leaves it, and a file
   * the system declines to open.
   */
  fsOpen(projectId: string, relPath: string): Promise<boolean>
  /**
   * Write one file of one project, refusing if it changed since it was read.
   *
   * `relPath` is relative to the project's own `cwd` and resolved against it
   * in main: no absolute path crosses this boundary. `expectedMtimeMs` is the
   * mtime the text on screen was read at. A path that would leave the project,
   * a directory, a missing file and a changed file all resolve to an `ok:
   * false` result rather than rejecting.
   */
  fsWrite(
    projectId: string,
    relPath: string,
    text: string,
    expectedMtimeMs: number,
  ): Promise<WriteResult>

  /**
   * Rename one entry, keeping it in the directory it is already in.
   *
   * `newName` is a single name, not a path: a separator in it would make this
   * a move, which the tree does not offer, and is refused rather than
   * sanitised. Like every `fs*` call the renderer names the entry by a
   * relative path and main resolves it under the project.
   */
  fsRename(projectId: string, relPath: string, newName: string): Promise<FsResult>

  /** Move one entry to the system Trash, where it stays recoverable. */
  fsTrash(projectId: string, relPath: string): Promise<FsResult>

  /** Show one entry in Finder. */
  fsReveal(projectId: string, relPath: string): Promise<FsResult>

  /**
   * Put one entry's path on the clipboard, absolute or relative to the project
   * root. Main writes the clipboard because main is the only side that holds
   * the absolute path.
   */
  fsCopyPath(projectId: string, relPath: string, kind: 'absolute' | 'relative'): Promise<FsResult>

  /**
   * Create an empty file or a directory called `name` inside `relDir`.
   *
   * Refuses a name that already exists rather than truncating what is there,
   * which is the one way this could destroy data.
   */
  fsCreate(
    projectId: string,
    relDir: string,
    name: string,
    kind: 'file' | 'directory',
  ): Promise<FsResult>

  /**
   * Every file in one project, as paths relative to its root.
   *
   * A snapshot per call with no watcher: the palette asks when it opens, the
   * way it already asks for skills, and a stale entry costs one failed open.
   */
  projectFiles(projectId: string): Promise<ProjectFileList>

  /**
   * The clipboard's text, for the pane menu's Paste.
   *
   * Main rather than the renderer: `navigator.clipboard.readText` needs a
   * permission this app never prompts for, and returns a rejected promise
   * without one. Electron's `clipboard` in main has no such gate.
   */
  /**
   * When each tab entered its current state, epoch ms, keyed by tab id.
   *
   * Its own call rather than a widening of `status`: that map's shape is read
   * in several places and one label is not worth changing all of them.
   */
  statusSince(): Promise<Record<string, number>>

  clipboardRead(): Promise<string>

  /** Put text on the clipboard, for the pane menu's Copy. */
  clipboardWrite(text: string): Promise<void>
  /**
   * Open one file of one project in an editor pane of its own, in a new tab.
   *
   * `relPath` is relative and resolved in main, like `fsList` and `fsRead`: the
   * absolute `filePath` on the pane this answers with is one main spelled, and
   * the renderer never supplies one. A path that would leave the project, and a
   * file that cannot be read, both resolve to null rather than rejecting, and
   * to no tab: a tab that could never show anything is worse than a click that
   * did nothing.
   *
   * The pane it resolves to founds its own tab, so the pane's id is that tab's
   * id. That is what makes this reply the same shape as `open`'s, and what lets
   * the renderer select the new tab by the pane it was handed.
   */
  openEditor(projectId: string, relPath: string): Promise<TabDescriptor | null>
  /**
   * Open a browser pane on `url`, or on `about:blank` when `url` is absent.
   *
   * `url` is whatever the caller typed, main runs it through `normaliseUrl`,
   * and the pane this answers with always carries the normalised result, never
   * the raw string. Unlike `openEditor`, this never returns an existing pane:
   * two browser panes open on the same page is a normal thing to want, so
   * every call mints a fresh one.
   */
  openBrowser(projectId: string, url?: string): Promise<TabDescriptor | null>
  /**
   * The loopback URL a dev server most recently announced in this project's
   * terminal output, or null when none has.
   *
   * Asked by project SLUG, deliberately unlike `openBrowser` directly above,
   * which is asked by project id. Main learns a URL from a pty chunk, and all
   * a pane carries is `projectSlug` (`TabDescriptor`), so the slug is the only
   * name main ever files one under. A caller holding a `ProjectDescriptor` has
   * both fields and has to hand each of these two calls its own: `slug` here,
   * `id` there. Nothing turns one name into the other on THIS call's path: the
   * handler reads the registry by the string it is given and consults no
   * config, so passing an id here answers null rather than the URL.
   * `openBrowser` above does read a slug off the row it finds by id, to stamp
   * the pane it writes, and that conversion is its own.
   *
   * Runtime only, and never persisted: a URL from a previous run is a lie the
   * moment that server is gone. It is dropped when the pane that announced it
   * dies, so an answer means some pane was alive and serving when it spoke,
   * not that the port is still open now.
   */
  devServerUrl(projectSlug: string): Promise<string | null>
  /**
   * Hand a URL to the default browser.
   *
   * In main because the renderer has no `shell`, and narrow on purpose: the
   * handler refuses anything that is not http(s), so a URL that arrived from
   * the network cannot become `file:` or a custom scheme registered by another
   * app on this machine.
   */
  openExternal(url: string): Promise<void>

  /**
   * The absolute path of a file dropped onto the window, or '' when it cannot
   * be resolved. Synchronous: a drop handler must read its files before the
   * event's list goes stale. See the preload for why this cannot be `File.path`.
   */
  pathForFile(file: File): string
  /**
   * A release newer than this build, pushed by main when it finds one.
   *
   * Push rather than poll: the check runs on main's own schedule, and the
   * renderer has nothing useful to ask before then. Returns an unsubscribe
   * function, like `onData` and `onExit`.
   */
  onUpdateAvailable(listener: (info: UpdateInfo) => void): () => void
  /**
   * Check right now and report everything, failures included.
   *
   * The one place an update failure is allowed to be visible: Settings' button
   * is the user asking, and a button that answers nothing reads as broken.
   * Ignores a previously skipped version for the same reason.
   */
  checkForUpdate(): Promise<UpdateCheckResult>
  /** Never mention this version again. Persisted outside the workspace config. */
  skipUpdate(version: string): Promise<void>
  /**
   * The version `skipUpdate` was last called with, or null when none is
   * skipped.
   *
   * Read fresh rather than cached, like `hooksState`: another pTerm window
   * can skip a version while this one's Settings pane is open. What lets
   * Settings say a result was already skipped, since `checkForUpdate` itself
   * always ignores the skip and reports the release either way.
   */
  skippedVersion(): Promise<string | null>
  /**
   * The running build's version, from `package.json` by way of
   * `app.getVersion()`.
   *
   * Asked for rather than baked into the bundle at build time: a version
   * compiled into the renderer would be whatever Vite saw, which in a dev run
   * is the source tree and in a packaged run is the same file main reads. One
   * of those two would eventually drift, and the drift would show up as the
   * app comparing releases against a version it is not.
   */
  appVersion(): Promise<string>
  /**
   * A project's branch and how far it is from its upstream, or null when its
   * cwd is not inside a git repository (and when the id names no project).
   *
   * Keyed by project id rather than by a path, like `fsList` and the notes
   * channels: main resolves the id to a cwd, so the renderer never hands main a
   * directory of its own choosing.
   */
  gitStatus(projectId: string): Promise<GitStatus | null>
  /**
   * Fetch, fast-forward and push the project's branch.
   *
   * The one channel here that writes to a user's repository. It refuses to
   * merge: a branch that has diverged comes back as an error rather than a
   * merge commit nobody asked for.
   */
  gitSync(projectId: string): Promise<GitSyncResult>
  /**
   * Every uncommitted change in the active project's repository, or null when
   * its cwd is not inside one.
   *
   * Keyed by project id rather than by a path, like every other channel here:
   * the renderer never names a directory main then runs a subprocess in.
   */
  gitChanges(projectId: string): Promise<GitChanges | null>
  /**
   * Stage `paths`, and answer with the change list as it stands afterwards.
   *
   * Paths are repo-relative, as `gitChanges` reports them. A path that does
   * not resolve inside the repository is dropped rather than run.
   */
  gitStage(projectId: string, paths: string[]): Promise<GitMutation>
  /** Unstage `paths`. The mirror of `gitStage`, with the same path rules. */
  gitUnstage(projectId: string, paths: string[]): Promise<GitMutation>
  /**
   * Commit, refusing if `expected` no longer describes the repository.
   *
   * `expected` is the branch and head from the `GitChanges` on screen. Passing
   * what was shown rather than re-reading in the renderer is the point: the
   * question is whether the repository moved since the user last saw it.
   */
  gitCommit(
    projectId: string,
    message: string,
    expected: { branch: string | null; head: string | null },
  ): Promise<GitMutation>
  /**
   * Undo the working-tree changes to `paths`, deleting any that are untracked.
   *
   * Irreversible. The caller is expected to have confirmed with the user
   * first; nothing in main asks.
   *
   * `expectedUntracked` is the subset of `paths` the confirm dialog told the
   * user would be deleted rather than restored. Main refuses the whole
   * batch, with no path acted on, when a fresh read disagrees with it: see
   * `discard` in `src/main/git/ops.ts` for why that check exists.
   */
  gitDiscard(projectId: string, paths: string[], expectedUntracked: string[]): Promise<GitMutation>
  /** Stash every change, untracked included. Recoverable via `git stash`. */
  gitStash(projectId: string): Promise<GitMutation>
  /**
   * The unified diff for one path, or null when there is none to show.
   *
   * An untracked file has no diff at all; main answers with the file's own
   * contents rendered as wholly added, so the pane has something true to show
   * rather than an error.
   */
  gitDiff(projectId: string, relPath: string, side: DiffSide): Promise<string | null>
  /**
   * Open a read-only diff pane for one path, or null when the project or the
   * path cannot be resolved.
   */
  openDiff(projectId: string, relPath: string, side: DiffSide): Promise<TabDescriptor | null>
  /** Lists issues in the active project's repository, filtered by `state`. */
  issuesList(projectId: string, state: IssueStateFilter): Promise<IssuesResult<IssueSummary[]>>
  /** Fetches one issue's full detail from the active project's repository. */
  issuesGet(projectId: string, number: number): Promise<IssuesResult<IssueDetail>>
  /** Opens a new issue in the active project's repository, answering with its number. */
  issuesCreate(projectId: string, title: string, body: string): Promise<IssuesResult<number>>
  /** Rewrites an issue's title and body in the active project's repository. */
  issuesEdit(projectId: string, number: number, title: string, body: string): Promise<IssuesResult<true>>
  /** Closes or reopens an issue in the active project's repository. */
  issuesSetState(
    projectId: string,
    number: number,
    action: 'close' | 'reopen',
    reason?: 'completed' | 'not planned',
  ): Promise<IssuesResult<true>>
  /** Adds a comment to an issue in the active project's repository. */
  issuesComment(projectId: string, number: number, body: string): Promise<IssuesResult<true>>
  /**
   * Tell main which side columns are collapsed, so the View menu's checkboxes
   * and its hide-all label can show the truth.
   *
   * Fire and forget, like `setActive`: main holds this only for display, and
   * the renderer stays the source of truth. A dropped message costs a stale
   * tick until the next change, never a wrong toggle, because every menu
   * command still asks the renderer to flip its own state.
   */
  columnsVisible(collapsed: ColumnVisibility): void
  /**
   * Values the main process puts on the command line at window creation,
   * readable synchronously before the first frame.
   *
   * An object rather than a field each: these are read once, at startup, by
   * code that cannot wait for a round trip, and a flat field per value grows
   * the bridge every time another one is needed. Both members are optional
   * because neither is always set.
   *
   * `webglLimit` is `PTERM_WEBGL_LIMIT`, verbatim: `webglPaneBudget` in
   * `renderer/lib/webglBudget.ts` is what interprets it, this end
   * deliberately does no parsing, so there is one place that decides what a
   * bad value means. `theme` is read by `bootTheme` in `renderer/theme.ts`.
   */
  env: { webglLimit?: string; theme?: string }
}

/**
 * Which side columns are collapsed, and the id each one is keyed by.
 *
 * The booleans are COLLAPSED rather than visible, matching the `*Collapsed`
 * state `App.tsx` holds and the `'0' means expanded` convention its stored
 * keys use. Declared here rather than only in
 * `src/renderer/lib/columnVisibility.ts`, which now imports and re-exports
 * both for its existing consumers, because `columnsVisible` above carries
 * this shape across the IPC boundary and main needs the same type the
 * renderer does.
 */
export type ColumnId =
  | 'tabs'
  | 'files'
  | 'skills'
  | 'presets'
  | 'prompts'
  | 'notes'
  | 'git'
  | 'issues'
  | 'todos'
  | 'browser'

export type ColumnVisibility = Record<ColumnId, boolean>

/**
 * Whether one column counts as collapsed, given what actually arrived over
 * the wire.
 *
 * Reads a missing or non-boolean key as collapsed, never as open: a
 * `ColumnVisibility` payload is plain JSON once it crosses `ipcMain.on`,
 * where the type above no longer holds anything to account, so a column
 * absent from a future payload (a renamed key, a seventh column a caller
 * forgot to add) must fail toward hiding a checkmark rather than toward the
 * menu claiming an already-shut column is open.
 */
export function columnIsCollapsed(collapsed: ColumnVisibility, id: ColumnId): boolean {
  return collapsed[id] !== false
}
