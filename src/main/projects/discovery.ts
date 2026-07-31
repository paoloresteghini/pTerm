import { readdir, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
// Declared with the other wire types: the renderer draws the picker these fill.
// Re-exported so existing importers keep working.
import type { Candidate } from '../../shared/ipc'

export type { Candidate }

/** A directory holding one of these is a project worth offering. */
const MARKERS = ['.git', 'package.json', 'composer.json']

/**
 * `PRCLI_PROJECTS_ROOT` exists so tests scan a temp directory instead of the
 * developer's real ~/Code, the same role PRCLI_CONFIG_DIR plays for config.
 */
export function projectsRoot(): string {
  return process.env.PRCLI_PROJECTS_ROOT ?? join(homedir(), 'Code')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Directories one level below the root that look like projects.
 *
 * One level only: the root holds around twenty candidates of which roughly a
 * quarter are wanted, and recursing would turn that into hundreds.
 */
export async function scanCandidates(taken: Iterable<string>): Promise<Candidate[]> {
  const already = new Set(taken)
  let entries
  try {
    entries = await readdir(projectsRoot(), { withFileTypes: true })
  } catch {
    // No root, or unreadable. The picker still offers "Choose folder…".
    return []
  }

  const candidates: Candidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const cwd = join(projectsRoot(), entry.name)
    if (already.has(cwd)) continue
    const markers: string[] = []
    for (const marker of MARKERS) {
      if (await exists(join(cwd, marker))) markers.push(marker)
    }
    if (markers.length > 0) candidates.push({ name: entry.name, cwd, markers })
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name))
}
