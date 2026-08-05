import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

/**
 * The boundary this module enforces is per-project containment: a project can
 * only ever be listed inside its own `cwd`, never anywhere else. It is not "the
 * renderer cannot enumerate the disk". The project's own root is chosen by
 * whatever added the project (`addProject` takes `{ name, cwd }` straight from
 * the renderer, unvalidated), so a compromised renderer that registers a
 * project rooted at `/` would still be free to list `/`; this module only
 * stops it from listing anywhere else.
 */

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
 *
 * True of ROWS, not of traversal: this only filters what `listDir` renders as
 * a row of its own directory. It does not stop a caller from asking for
 * `.git` or `node_modules` by path, and `listDir(root, '.git')` returns
 * `.git`'s contents rather than an empty list. Nothing in the app does that
 * today; if that ever changes, this set does not cover it.
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
 *
 * `relPath` is `unknown` in every way that matters: IPC does not check the
 * type it declares. `isAbsolute` throws a `TypeError` on anything that is not
 * a string, which would otherwise turn a malformed message into a main-process
 * crash rather than an empty list, so the type is checked here before that.
 *
 * `root` is resolved once, up front. `config.json` is hand-editable, and a
 * trailing separator on it (`/a/b/`) is not equal to the `/a/b` this function
 * builds from `resolve`, so `isInside` would reject every target under it and
 * the whole tree would silently render empty.
 */
export function resolveInside(root: string, relPath: string): string | null {
  if (typeof relPath !== 'string') return null
  if (isAbsolute(relPath)) return null
  const cleanRoot = resolve(root)
  const target = resolve(cleanRoot, relPath)
  return isInside(cleanRoot, target) ? target : null
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

/** One file's text, with the mtime it had when it was read. */
export interface FileContents {
  text: string
  mtimeMs: number
}

/**
 * One file of one project, or null.
 *
 * The same containment guard `listDir` uses, for the same reason and by the
 * same two halves: `resolveInside` for the path the renderer spelled, and a
 * `realpath` re-check for the one it did not, since `readFile` follows a
 * symlink exactly as `readdir` does.
 *
 * Never throws. A missing file, a directory, an unreadable file and a path
 * that leaves the project are all null: this is called from a React render,
 * and the pane draws "cannot read that" rather than the app failing.
 *
 * The mtime rides along because a later slice refuses to write over a file
 * that changed underneath the pane, and that check needs the mtime the text
 * was read at rather than one fetched separately afterwards.
 */
export async function readFileInside(root: string, relPath: string): Promise<FileContents | null> {
  const target = resolveInside(root, relPath)
  if (target === null) return null
  try {
    const realRoot = await realpath(root)
    const realTarget = await realpath(target)
    if (!isInside(realRoot, realTarget)) return null
    const info = await stat(realTarget)
    if (!info.isFile()) return null
    return { text: await readFile(realTarget, 'utf8'), mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
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
    // `stat`, not `readdir`: this only needs to know the KIND, which is the
    // whole reason `listDir` reads its own directory with `withFileTypes`
    // rather than a `stat` per entry. Reading every entry of `real` here to
    // answer "is it a directory" would undercut that.
    return (await stat(real)).isDirectory()
  } catch {
    return false
  }
}
