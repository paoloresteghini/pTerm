import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TabRecord } from '../sessions/manager'

export interface Preset {
  id: string
  label: string
  command: string
}

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
  version: 3
  /** Array order is sidebar order, and the order ⌘1–9 follows. */
  projects: ProjectRecord[]
  activeProjectId: string | null
  tabs: TabRecord[]
}

const EMPTY: PrcliConfig = { version: 3, projects: [], activeProjectId: null, tabs: [] }

function hasTabs(value: unknown): value is { version: number; tabs: TabRecord[] } {
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

/** Tolerate a project row missing its optional arrays rather than dropping it. */
function normaliseProject(project: ProjectRecord): ProjectRecord {
  return {
    ...project,
    presets: Array.isArray(project.presets) ? project.presets : [],
    activeTabId: typeof project.activeTabId === 'string' ? project.activeTabId : null,
  }
}

/**
 * v1 had no active tab. v2 had one, globally — a notion v3 replaces with one
 * per project, so it is dropped rather than guessed at.
 *
 * Neither v1 nor v2 had projects, and their tabs all carry the slug of the
 * single hardcoded project that no longer exists. Synthesising a project from
 * that slug is the auto-create-from-slug behaviour this milestone rejects, so
 * migrated tabs belong to nothing and restore lists them under Unsorted.
 */
function migrate(value: unknown): PrcliConfig {
  if (!hasTabs(value)) return { ...EMPTY }
  if (value.version === 3) {
    const v3 = value as Partial<PrcliConfig>
    const projects = Array.isArray(v3.projects) ? v3.projects.filter(isProject) : []
    return {
      version: 3,
      projects: projects.map(normaliseProject),
      activeProjectId: typeof v3.activeProjectId === 'string' ? v3.activeProjectId : null,
      tabs: value.tabs,
    }
  }
  if (value.version === 1 || value.version === 2) {
    return { version: 3, projects: [], activeProjectId: null, tabs: value.tabs }
  }
  // A version from the future: refuse to guess at its shape.
  return { ...EMPTY }
}

export class ConfigStore {
  constructor(private readonly filePath: string) {}

  /** `PRCLI_CONFIG_DIR` exists so tests can point at a temp dir instead of the real config. */
  static defaultPath(): string {
    const root = process.env.PRCLI_CONFIG_DIR ?? join(homedir(), '.prcli')
    return join(root, 'config.json')
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

  /** Serialise first, then write to a temp file and rename over the target. */
  async write(config: PrcliConfig): Promise<void> {
    const json = JSON.stringify(config, null, 2)
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
