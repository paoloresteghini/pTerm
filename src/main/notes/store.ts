import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configRoot } from '../state/store'

/**
 * Where a project's note lives, or null for an id this module refuses.
 *
 * Ids are app-allocated and never user text, so the `/` and `..` check is
 * cheap insurance rather than a sanitisation layer: an id that would escape
 * `notes/` reads as empty and writes nowhere.
 */
function notePath(projectId: string): string | null {
  if (projectId.length === 0 || projectId.includes('/') || projectId.includes('..')) return null
  return join(configRoot(), 'notes', `${projectId}.md`)
}

/** The note's text, `''` for no note. Never rejects, like `ConfigStore.read`. */
export async function readNote(projectId: string): Promise<string> {
  const path = notePath(projectId)
  if (path === null) return ''
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** Serialise-free atomic write: temp file in the same directory, then rename. */
export async function writeNote(projectId: string, text: string): Promise<void> {
  const path = notePath(projectId)
  if (path === null) return
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
