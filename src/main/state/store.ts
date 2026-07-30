import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TabRecord } from '../sessions/manager'

export interface PrcliConfig {
  version: 2
  /** Which tab the window should show on launch. */
  activeTabId: string | null
  /** Display order. */
  tabs: TabRecord[]
}

interface PrcliConfigV1 {
  version: 1
  tabs: TabRecord[]
}

const EMPTY: PrcliConfig = { version: 2, activeTabId: null, tabs: [] }

function hasTabs(value: unknown): value is { version: number; tabs: TabRecord[] } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { version?: unknown; tabs?: unknown }
  return typeof candidate.version === 'number' && Array.isArray(candidate.tabs)
}

/**
 * v1 had no active tab and no explicit ordering — array order was incidental.
 * Treating it as the order and making the first tab active is the closest
 * honest reading of an old file.
 */
function migrate(value: unknown): PrcliConfig {
  if (!hasTabs(value)) return { ...EMPTY }
  if (value.version === 2) {
    const v2 = value as Partial<PrcliConfig>
    return {
      version: 2,
      activeTabId: typeof v2.activeTabId === 'string' ? v2.activeTabId : null,
      tabs: value.tabs,
    }
  }
  if (value.version === 1) {
    const v1 = value as PrcliConfigV1
    return { version: 2, activeTabId: v1.tabs[0]?.id ?? null, tabs: v1.tabs }
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
