import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configRoot } from '../state/store'

/**
 * One version string, in a file of its own.
 *
 * Deliberately NOT a field on `PrcliConfig`. That store is at `version: 8`,
 * and adding a field to it means a migration to 9 plus an entry in
 * `attachSavedFields`, both on the path that decides what survives a
 * relaunch, for a value nothing but this module ever reads. A file of its own
 * costs thirty lines and cannot break restore.
 *
 * `configRoot()` reads `PRCLI_CONFIG_DIR` at call time, so a test pointing
 * that at a temp dir gets its own file, same as `ConfigStore.defaultPath()`.
 */
export function skipPath(): string {
  return join(configRoot(), 'update.json')
}

interface SkipFile {
  skipped: string
}

/**
 * The version the user chose to skip, or null.
 *
 * Never rejects. A missing file is the normal state, and a damaged one is
 * worth exactly as little: the cost of reading either as "nothing skipped" is
 * one banner the user has already seen, which is a better failure than an
 * update check that throws on startup.
 */
export async function readSkipped(): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(skipPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { skipped } = parsed as Partial<SkipFile>
    return typeof skipped === 'string' ? skipped : null
  } catch {
    return null
  }
}

/** Atomic, the same temp-then-rename shape `notes/store.ts` uses. */
export async function writeSkipped(version: string): Promise<void> {
  const path = skipPath()
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const body: SkipFile = { skipped: version }
  try {
    await writeFile(temp, JSON.stringify(body), 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
