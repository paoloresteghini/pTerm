import type { TabState } from './status'

export type { TabState }

export const CHANNELS = {
  open: 'prcli:open',
  list: 'prcli:list',
  input: 'prcli:input',
  resize: 'prcli:resize',
  detach: 'prcli:detach',
  kill: 'prcli:kill',
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
  data: 'prcli:data',
  exit: 'prcli:exit',
  status: 'prcli:status',
  statusChanged: 'prcli:statusChanged',
  restartTab: 'prcli:restartTab',
  dismissTab: 'prcli:dismissTab',
  focusTab: 'prcli:focusTab',
  notifications: 'prcli:notifications',
  updateNotifications: 'prcli:updateNotifications',
  hooksState: 'prcli:hooksState',
  installHooks: 'prcli:installHooks',
  uninstallHooks: 'prcli:uninstallHooks',
  menuCommand: 'prcli:menuCommand',
} as const

/**
 * What a clicked menu item asks the renderer to do.
 *
 * The accelerators themselves stay unregistered (`registerAccelerator: false`)
 * so the keystroke still reaches the renderer's own handler rather than being
 * claimed by the menu — that part was always right. What was missing is that
 * *clicking* the item did nothing at all, because the renderer owns every one
 * of these actions and main had no way to ask for them.
 */
export type MenuCommand = 'newTab' | 'closeTab' | 'togglePresets' | 'settings'

/**
 * What a tab was launched as.
 *
 * A declaration of intent, not a gate on status: it decides the launch command
 * and whether an expecting-hooks dot is drawn before any event has arrived.
 * Every tab carries PRCLI_TAB_ID regardless, so a `claude` typed by hand into
 * a shell tab gets full status the moment its first hook lands.
 */
export type TabType = 'claude' | 'preset' | 'shell'

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

export interface TabDescriptor {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
  type: TabType
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

/** What Restart needs: the dead tab's record, plus the size to attach at. */
export interface RestartRequest {
  tab: TabDescriptor
  cols?: number
  rows?: number
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
  tabs: TabDescriptor[]
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
  input(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  detach(id: string): void
  kill(id: string): Promise<void>
  onData(listener: (event: DataEvent) => void): () => void
  onExit(listener: (event: ExitEvent) => void): () => void
  /** Every tab's state, for a renderer that has just mounted or reloaded. */
  status(): Promise<Record<string, TabState>>
  onStatus(listener: (event: StatusEvent) => void): () => void
  /** Recreate a dead tab's session under the same id, cwd, command and type. */
  restartTab(request: RestartRequest): Promise<TabDescriptor>
  /** Stop tracking a dead tab: the renderer has dropped its tombstone. */
  dismissTab(id: string): void
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
}
