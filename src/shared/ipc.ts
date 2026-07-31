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
} as const

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
  /** Moves the tab by renaming its tmux session; everything in it keeps running. */
  moveTabToProject(
    tabId: string,
    projectId: string,
  ): Promise<{ projects: ProjectDescriptor[]; tab: TabDescriptor }>
  input(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  detach(id: string): void
  kill(id: string): Promise<void>
  onData(listener: (event: DataEvent) => void): () => void
  onExit(listener: (event: ExitEvent) => void): () => void
}
