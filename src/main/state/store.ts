import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TabRecord } from '../sessions/manager'

export interface PrcliConfig {
  version: 1
  tabs: TabRecord[]
}

const EMPTY: PrcliConfig = { version: 1, tabs: [] }

function isValid(value: unknown): value is PrcliConfig {
  if (typeof value !== 'object' || value === null) return false
  const config = value as Partial<PrcliConfig>
  return config.version === 1 && Array.isArray(config.tabs)
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
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return isValid(parsed) ? parsed : { ...EMPTY }
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
