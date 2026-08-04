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
 * Whether `path` is inside `root`, using string comparison.
 *
 * The trailing separator on the comparison is load-bearing. A plain
 * `startsWith(root)` accepts `/a/bb` for a root of `/a/b`, which is a sibling
 * directory, not a child.
 */
function isInside(root: string, path: string): boolean {
  if (path === root) return true
  return path.startsWith(root + sep)
}

/**
 * `relPath` resolved under `root`, or null if it does not stay there.
 *
 * The renderer is web content and an IPC channel that lists a directory is a
 * directory-listing primitive for anything that reaches it. So no absolute
 * path crosses IPC, and this is where a relative one is checked rather than
 * trusted.
 */
export function resolveInside(root: string, relPath: string): string | null {
  if (isAbsolute(relPath)) return null
  const target = resolve(root, relPath)
  return isInside(root, target) ? target : null
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
 * `withFileTypes` gives the kind without a `stat` per entry. A symlink in the
 * target directory is resolved with `realpath` to check if it leaves the
 * project: one that does is reported as a leaf (dir: false) in the parent
 * listing. A symlink passed as `relPath` itself is caught by realpath
 * resolution before readdir: if a traversal uses it, it returns empty.
 */
export async function listDir(root: string, relPath: string): Promise<FileEntry[]> {
  const target = resolveInside(root, relPath)
  if (target === null) return []

  let realRoot: string
  let realTarget: string
  try {
    realRoot = await realpath(root)
    realTarget = await realpath(target)
  } catch {
    return []
  }

  if (!isInside(realRoot, realTarget)) return []

  let found
  try {
    found = await readdir(realTarget, { withFileTypes: true })
  } catch {
    return []
  }

  const entries: FileEntry[] = []
  for (const entry of found) {
    if (HIDDEN.has(entry.name)) continue
    if (entry.isSymbolicLink()) {
      entries.push({ name: entry.name, dir: await symlinkIsInsideDir(realRoot, realTarget, entry.name) })
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
 * symlink is resolved by `listDir` before it is shown in a listing, and this
 * verifies it stays in the project and is a directory.
 */
async function symlinkIsInsideDir(root: string, target: string, name: string): Promise<boolean> {
  try {
    const real = await realpath(join(target, name))
    if (!isInside(root, real)) return false
    // Reached only to answer "is it a directory". `readdir` throws ENOTDIR on
    // a file, which is the whole test; the entries themselves are read again
    // if and when the row is expanded.
    await readdir(real)
    return true
  } catch {
    return false
  }
}
