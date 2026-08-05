import type { TabState } from './status'
import type { PaneColor } from './paneColors'

export type { TabState }

export const CHANNELS = {
  open: 'prcli:open',
  list: 'prcli:list',
  input: 'prcli:input',
  resize: 'prcli:resize',
  detach: 'prcli:detach',
  restore: 'prcli:restore',
  setActive: 'prcli:setActive',
  addProject: 'prcli:addProject',
  updateProject: 'prcli:updateProject',
  removeProject: 'prcli:removeProject',
  reorderProjects: 'prcli:reorderProjects',
  setActiveProject: 'prcli:setActiveProject',
  scanCandidates: 'prcli:scanCandidates',
  pickFolder: 'prcli:pickFolder',
  moveTabToProject: 'prcli:moveTabToProject',
  renameTab: 'prcli:renameTab',
  setPaneColor: 'prcli:setPaneColor',
  data: 'prcli:data',
  exit: 'prcli:exit',
  status: 'prcli:status',
  statusChanged: 'prcli:statusChanged',
  restartTab: 'prcli:restartTab',
  dismissTab: 'prcli:dismissTab',
  splitPane: 'prcli:splitPane',
  closePane: 'prcli:closePane',
  focusTab: 'prcli:focusTab',
  notifications: 'prcli:notifications',
  updateNotifications: 'prcli:updateNotifications',
  hooksState: 'prcli:hooksState',
  installHooks: 'prcli:installHooks',
  uninstallHooks: 'prcli:uninstallHooks',
  menuCommand: 'prcli:menuCommand',
  setLayout: 'prcli:setLayout',
  skills: 'prcli:skills',
  notesRead: 'prcli:notesRead',
  notesWrite: 'prcli:notesWrite',
  fsList: 'prcli:fsList',
  fsRead: 'prcli:fsRead',
  openEditor: 'prcli:openEditor',
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
  | 'togglePresets'
  | 'settings'

/**
 * What a tab was launched as.
 *
 * A declaration of intent, not a gate on status: it decides the launch command
 * and whether an expecting-hooks dot is drawn before any event has arrived.
 * Every tab carries PRCLI_TAB_ID regardless, so a `claude` typed by hand into
 * a shell tab gets full status the moment its first hook lands. `editor` is
 * the exception: it has no launch command at all.
 */
export type TabType = 'claude' | 'preset' | 'shell' | 'editor'

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

export interface TabDescriptor {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  /**
   * Absent on an editor pane, which has no tmux session at all. Present on
   * every terminal pane, which is what `isPane` still enforces per kind.
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
   * The file an editor pane is showing, absolute. Absent on every terminal
   * pane, and absent on an editor pane whose file could not be read.
   *
   * Absolute here and relative across `fsRead`: this is written by main and
   * read back by main, and never spelled by the renderer.
   */
  filePath?: string
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
}

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
   * The axis to arrange the tab along — honoured only by the split that turns
   * a single pane into a split tab.
   *
   * A tab that is already split keeps the axis it has and the new pane joins
   * it, so asking for the other direction adds a pane rather than re-orienting
   * the panes already there. A ruling, not a consequence of one-axis-per-tab:
   * re-orienting reflows every pane in the tab and resizes its tmux session,
   * which is a cost paid by panes the user did not act on. See `splitPane`.
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

export interface ProjectDescriptor {
  id: string
  name: string
  slug: string
  cwd: string
  presets: ResolvedPreset[]
  activeTabId: string | null
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

export interface PrcliApi {
  open(request: OpenRequest): Promise<TabDescriptor>
  list(): Promise<TabDescriptor[]>
  /** Reattach tabs persisted by the previous run; returns what came back. */
  restore(): Promise<RestoreResult>
  setActive(id: string | null): void
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
   * Add a pane to the tab that already holds `request.paneId`, beside it.
   *
   * Resolves to the whole tab — see `TabShape` — because the new pane's `kids`
   * position and the tab's new ratios are as much of the answer as the pane
   * itself. Rejects when no size was measured; see `SplitRequest`.
   */
  splitPane(request: SplitRequest): Promise<TabShape>
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
  /** Whether PRCLI's hooks are installed, and what installing would add. */
  hooksState(): Promise<HooksState>
  /** Writes a timestamped backup, then merges PRCLI's hooks into settings.json. */
  installHooks(): Promise<HooksState>
  /** Removes only PRCLI's own hook groups, restoring the file it found. */
  uninstallHooks(): Promise<HooksState>
  /**
   * Every skill and command available to the project at `projectCwd`.
   *
   * Read fresh on each call rather than cached: the panel and the palette
   * both call this on open, and a skill written a minute ago should be there.
   */
  skills(projectCwd: string): Promise<SkillEntry[]>
  /** The project's note text, `''` when none has been written. */
  notesRead(projectId: string): Promise<string>
  /**
   * Overwrite the project's note. Atomic on disk; the renderer treats it as
   * fire-and-forget and swallows a rejection, since the text is still on
   * screen and this panel is not where transport faults get reported.
   */
  notesWrite(projectId: string, text: string): Promise<void>
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
}
