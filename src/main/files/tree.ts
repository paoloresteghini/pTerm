import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** One row of a directory, as the sidebar draws it. */
export interface FileEntry {
  name: string
  dir: boolean
}

/**
 * Names never shown, matched at any depth.
 *
 * Two entries, not a general dotfile rule: a project's `.env` and `.claude`
 * are exactly the things worth reaching from a file tree. These two are hidden
 * because they are large and never edited by hand, not because they are
 * hidden files.
 */
const HIDDEN: ReadonlySet<string> = new Set(['.git', 'node_modules'])

/**
 * `relPath` resolved under `root`, or null if it does not stay there.
 *
 * The renderer is web content and an IPC channel that lists a directory is a
 * directory-listing primitive for anything that reaches it. So no absolute
 * path crosses IPC, and this is where a relative one is checked rather than
 * trusted.
 *
 * The trailing separator on the comparison is load-bearing. A plain
 * `startsWith(root)` accepts `/a/bb` for a root of `/a/b`, which is a sibling
 * directory, not a child.
 */
export function resolveInside(root: string, relPath: string): string | null {
  if (isAbsolute(relPath)) return null
  const target = resolve(root, relPath)
  if (target === root) return target
  return target.startsWith(root + sep) ? target : null
}

/**
 * The entries of one directory of one project: directories first, then files,
 * each group alphabetical.
 *
 * Never throws. A directory that is missing, or that this process cannot read,
 * is an empty list: a permission error should be a leaf that does not open,
 * not a sidebar that fails to render. The caller cannot tell those apart and
 * does not need to.
 *
 * `withFileTypes` gives the kind without a `stat` per entry. A symlink reports
 * as neither file nor directory, so it is resolved separately, and one that
 * leaves the project is reported as a leaf: `resolveInside` cannot see through
 * a symlink, so this is the half of the guard that covers it.
 */
export async function listDir(root: string, relPath: string): Promise<FileEntry[]> {
  const target = resolveInside(root, relPath)
  if (target === null) return []

  let found
  try {
    found = await readdir(target, { withFileTypes: true })
  } catch {
    return []
  }

  const entries: FileEntry[] = []
  for (const entry of found) {
    if (HIDDEN.has(entry.name)) continue
    if (entry.isSymbolicLink()) {
      entries.push({ name: entry.name, dir: await symlinkIsInsideDir(root, target, entry.name) })
      continue
    }
    entries.push({ name: entry.name, dir: entry.isDirectory() })
  }

  return entries.sort((left, right) => {
    if (left.dir !== right.dir) return left.dir ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

/**
 * Whether `name` in `target` is a directory the tree may expand into: a
 * symlink that resolves to a directory still inside `root`.
 *
 * False for a broken link and false for one pointing out of the project. The
 * second is the point. `resolveInside` checks the path the renderer asked
 * for, and a symlink is a path the renderer never had to spell.
 */
async function symlinkIsInsideDir(root: string, target: string, name: string): Promise<boolean> {
  try {
    const real = await realpath(join(target, name))
    if (real !== root && !real.startsWith(root + sep)) return false
    // Reached only to answer "is it a directory". `readdir` throws ENOTDIR on
    // a file, which is the whole test; the entries themselves are read again
    // if and when the row is expanded.
    await readdir(real)
    return true
  } catch {
    return false
  }
}
