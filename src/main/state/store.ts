import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PaneRecord } from '../sessions/manager'
// Declared with the other wire types: the renderer edits presets and sends them
// back, and a second structurally identical declaration here would only invite
// drift. Re-exported so existing importers keep working.
import type { NotificationConfig, Preset, TabType } from '../../shared/ipc'

export type { Preset }

export interface ProjectRecord {
  id: string
  /** Display name. Freely renameable — the slug does not follow it. */
  name: string
  /** Immutable once allocated: it is baked into every session name. */
  slug: string
  cwd: string
  /** User-defined only. Repo presets merge in above this at read time. */
  presets: Preset[]
  /** Per-project, so returning to a project lands where you left it. */
  activeTabId: string | null
}

export interface PrcliConfig {
  version: 4
  /** Array order is sidebar order, and the order ⌘1–9 follows. */
  projects: ProjectRecord[]
  activeProjectId: string | null
  tabs: PaneRecord[]
  notifications: NotificationConfig
}

/**
 * Toast on, sound off.
 *
 * The parent spec names Funk for `waiting` and Glass for `idle`, but this
 * machine's ~/.claude/settings.json already runs `afplay` on Notification and
 * Stop with exactly those two sounds, so shipping them would double-fire. The
 * install screen names the collision instead, and the pickers start unset.
 */
export const DEFAULT_NOTIFICATIONS: NotificationConfig = {
  rules: [
    { on: 'waiting', toast: true, sound: null, urgency: 'high' },
    { on: 'crashed', toast: true, sound: null, urgency: 'high' },
    { on: 'idle', toast: true, sound: null, urgency: 'low' },
  ],
  muteWhenFocused: true,
  quietHours: null,
}

const EMPTY: PrcliConfig = {
  version: 4,
  projects: [],
  activeProjectId: null,
  tabs: [],
  notifications: DEFAULT_NOTIFICATIONS,
}

function hasTabs(value: unknown): value is { version: number; tabs: unknown[] } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { version?: unknown; tabs?: unknown }
  return typeof candidate.version === 'number' && Array.isArray(candidate.tabs)
}

function isProject(value: unknown): value is ProjectRecord {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<ProjectRecord>
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.slug === 'string' &&
    typeof p.cwd === 'string'
  )
}

/**
 * A tab row that restore can actually use.
 *
 * Validated for the same reason project rows are: `read()` promises never to
 * throw, and handing `restore.ts` a `null` it dereferences is that promise
 * broken one frame later rather than kept. A row missing only its optional
 * `type` is normalised, not dropped — a live session is worth more than a
 * correct type field.
 */
function isTab(value: unknown): value is PaneRecord {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Partial<PaneRecord>
  return (
    typeof t.id === 'string' &&
    typeof t.projectSlug === 'string' &&
    typeof t.cwd === 'string' &&
    typeof t.tmuxSession === 'string'
  )
}

const TAB_TYPES: readonly TabType[] = ['claude', 'preset', 'shell']

function normaliseTab(tab: PaneRecord): PaneRecord {
  if (TAB_TYPES.includes(tab.type)) return tab
  // A v3 row cannot say whether it was running Claude, and does not need to —
  // hooks decide that. Only the launch command is knowable from the record.
  return { ...tab, type: tab.command === undefined ? 'shell' : 'preset' }
}

/** Tolerate a project row missing its optional arrays rather than dropping it. */
function normaliseProject(project: ProjectRecord): ProjectRecord {
  return {
    ...project,
    presets: Array.isArray(project.presets) ? project.presets : [],
    activeTabId: typeof project.activeTabId === 'string' ? project.activeTabId : null,
  }
}

/**
 * Same tolerance the project rows get: a hand-edited rules array that is the
 * wrong shape costs its own contents, not every open tab.
 */
function normaliseNotifications(value: unknown): NotificationConfig {
  if (typeof value !== 'object' || value === null) return DEFAULT_NOTIFICATIONS
  const n = value as Partial<NotificationConfig>
  return {
    rules: Array.isArray(n.rules) ? n.rules : DEFAULT_NOTIFICATIONS.rules,
    muteWhenFocused:
      typeof n.muteWhenFocused === 'boolean'
        ? n.muteWhenFocused
        : DEFAULT_NOTIFICATIONS.muteWhenFocused,
    quietHours:
      typeof n.quietHours === 'object' &&
      n.quietHours !== null &&
      typeof n.quietHours.from === 'string' &&
      typeof n.quietHours.to === 'string'
        ? { from: n.quietHours.from, to: n.quietHours.to }
        : null,
  }
}

/**
 * v1 had no active tab. v2 had one, globally — a notion v3 replaced with one
 * per project, so it is dropped rather than guessed at. v4 adds a tab type and
 * notification rules; neither is derivable from an older file, so both take
 * defaults.
 *
 * Neither v1 nor v2 had projects, and their tabs all carry the slug of the
 * single hardcoded project that no longer exists. Synthesising a project from
 * that slug is the auto-create-from-slug behaviour M2b rejected, so migrated
 * tabs belong to nothing and restore lists them under Unsorted.
 */
function migrate(value: unknown): PrcliConfig {
  if (!hasTabs(value)) return { ...EMPTY }

  // Every version this function accepts validates its tabs the same way, so
  // the filter is shared rather than repeated per branch.
  const tabs = value.tabs.filter(isTab).map(normaliseTab)

  if (value.version === 4) {
    const v4 = value as Partial<PrcliConfig>
    const projects = Array.isArray(v4.projects) ? v4.projects.filter(isProject) : []
    return {
      version: 4,
      projects: projects.map(normaliseProject),
      activeProjectId: typeof v4.activeProjectId === 'string' ? v4.activeProjectId : null,
      tabs,
      notifications: normaliseNotifications(v4.notifications),
    }
  }
  if (value.version === 3) {
    const v3 = value as { projects?: unknown; activeProjectId?: unknown }
    const projects = Array.isArray(v3.projects) ? v3.projects.filter(isProject) : []
    return {
      version: 4,
      projects: projects.map(normaliseProject),
      activeProjectId: typeof v3.activeProjectId === 'string' ? v3.activeProjectId : null,
      tabs,
      notifications: DEFAULT_NOTIFICATIONS,
    }
  }
  if (value.version === 1 || value.version === 2) {
    return {
      version: 4,
      projects: [],
      activeProjectId: null,
      tabs,
      notifications: DEFAULT_NOTIFICATIONS,
    }
  }
  // A version from the future: refuse to guess at its shape.
  return { ...EMPTY }
}

/**
 * The directory `PRCLI_CONFIG_DIR` names, defaulting to `~/.prcli`.
 *
 * Exported because config.json is no longer the only thing that lives there:
 * the hook socket, the spool and the installed hook script are all siblings of
 * it, and every one of them must move with the escape hatch so a test never
 * reaches the real `~/.prcli`.
 */
export function configRoot(): string {
  return process.env.PRCLI_CONFIG_DIR ?? join(homedir(), '.prcli')
}

export class ConfigStore {
  constructor(private readonly filePath: string) {}

  /** `PRCLI_CONFIG_DIR` exists so tests can point at a temp dir instead of the real config. */
  static defaultPath(): string {
    return join(configRoot(), 'config.json')
  }

  /**
   * Never throws. A missing or damaged config must not stop the app from
   * starting — the worst case is losing layout, which the user can rebuild.
   */
  async read(): Promise<PrcliConfig> {
    try {
      return migrate(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch {
      return { ...EMPTY }
    }
  }

  /**
   * The `version` the file on disk claims, or null if it does not claim one.
   *
   * Null covers a missing file, a damaged one, and a file with no version
   * field — all cases where writing must go ahead. A single corrupt byte
   * locking the config against every future write would be a worse failure
   * than the one the guard below prevents.
   */
  private async versionOnDisk(): Promise<number | null> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as { version?: unknown }
      return typeof value.version === 'number' ? value.version : null
    } catch {
      return null
    }
  }

  /** Serialise first, then write to a temp file and rename over the target. */
  async write(config: PrcliConfig): Promise<void> {
    // Before the guard, so unserialisable input still rejects rather than
    // being quietly swallowed by a refusal it has nothing to do with.
    const json = JSON.stringify(config, null, 2)

    // `migrate` returns empty for a version it does not understand, so an
    // older build reads a newer config as "no config" and then writes a full
    // one over it — losing every project, preset and rule in it. That was
    // theoretical until a v4 file existed; a packaged build and a dev build
    // have since shared one all day.
    //
    // Refused rather than thrown: the cost of running the old build is losing
    // layout changes, and a rejected promise here would surface as a failed
    // IPC call on every ordinary edit instead.
    const existing = await this.versionOnDisk()
    if (existing !== null && existing > config.version) {
      console.warn(
        `PRCLI: refusing to overwrite ${this.filePath} — it is version ${existing} and this ` +
          `build writes version ${config.version}. Run the newer build, or move that file aside.`,
      )
      return
    }

    await mkdir(dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.${process.pid}.tmp`
    try {
      await writeFile(temp, json, 'utf8')
      await rename(temp, this.filePath)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}
