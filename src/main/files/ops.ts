import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { FsResult } from '../../shared/ipc'
import { resolveInside } from './tree'

/**
 * Where the mutating half of the file tree is allowed to write.
 *
 * The renderer addresses a file by `(projectId, relPath)` and never by an
 * absolute path, so these functions are the whole boundary: anything they
 * refuse is something the app cannot be made to write. `resolveInside` already
 * guards the relative path — see its own notes for why it resolves the root
 * first — and what is added here is the NAME, which is new user input typed
 * into a row and must not be able to move a file somewhere else.
 *
 * Path logic only. `shell.trashItem`, `shell.showItemInFolder` and `clipboard`
 * live in the IPC handlers, where they cannot be unit tested; keeping the
 * decisions here means the part that can be wrong is under test.
 */

/**
 * Whether a string is usable as a single file or directory name.
 *
 * A separator would turn a rename into a MOVE, which is not what the menu
 * offers and is the shape every escape takes. `.` and `..` are refused for the
 * same reason. Refused rather than sanitised: a caller asking to move a file
 * is asking for something these functions do not do, and quietly rewriting the
 * name would be a worse answer than declining.
 *
 * A null byte is refused explicitly. Node throws on one rather than truncating,
 * so this is about giving the caller a null instead of an exception, but the
 * check is cheap and the failure it prevents is the classic one.
 */
function isPlainName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name.includes('\0')) return false
  return true
}

/** Both ends of a rename, absolute, or null when it is not allowed. */
export interface RenameTarget {
  from: string
  to: string
}

/**
 * Rename `relPath` to `newName`, keeping it in the directory it is already in.
 *
 * Null when the path escapes the project or the name is not a plain one. The
 * destination is built from the resolved source's directory rather than from
 * the caller's string, so there is no second path to validate.
 */
export function renameTarget(root: string, relPath: string, newName: string): RenameTarget | null {
  const from = resolveInside(root, relPath)
  if (from === null) return null
  if (!isPlainName(newName)) return null
  return { from, to: join(dirname(from), newName) }
}

/**
 * Where a new file or directory called `name` goes inside `relDir`.
 *
 * Null on the same terms as `renameTarget`. An empty `relDir` is the project
 * root, which is what a create from the tree's top level asks for.
 */
export function createTarget(root: string, relDir: string, name: string): string | null {
  const dir = resolveInside(root, relDir === '' ? '.' : relDir)
  if (dir === null) return null
  if (!isPlainName(name)) return null
  return join(dir, name)
}

/** A file's two names, for the two copy items in the menu. */
export interface CopyPaths {
  absolute: string
  relative: string
}

/**
 * The absolute and project-relative paths of `relPath`.
 *
 * The relative one is recomputed from the resolved absolute path rather than
 * echoed back, so `src/./a.ts` copies as `src/a.ts` and a caller cannot
 * round-trip an unnormalised string through the user's clipboard.
 */
export function pathsFor(root: string, relPath: string): CopyPaths | null {
  const absolute = resolveInside(root, relPath)
  if (absolute === null) return null
  return { absolute, relative: relative(resolve(root), absolute) }
}

/**
 * Rename one entry, refusing to replace anything already there.
 *
 * `rename(2)` REPLACES its destination silently, which would make a mistyped
 * name destroy a file. The `access` check in front of it is what stops that.
 * It does not close the race between the check and the rename: that gap is the
 * difference between a typo clobbering a file, which this prevents, and two
 * deliberate renames colliding in the same millisecond, which it does not.
 *
 * Renaming an entry to the name it already has is a no-op rather than a
 * collision, so a rename field dismissed unchanged does not report an error.
 */
export async function renameEntry(
  root: string,
  relPath: string,
  newName: string,
): Promise<FsResult> {
  const target = renameTarget(root, relPath, newName)
  if (target === null) return { ok: false, error: 'That name cannot be used here' }
  if (target.from === target.to) return { ok: true }
  try {
    await access(target.to)
    return { ok: false, error: 'Something with that name is already here' }
  } catch {
    // Nothing at the destination, which is the case we want.
  }
  try {
    await rename(target.from, target.to)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Rename failed' }
  }
}

/**
 * Create an empty file or a directory, refusing to touch one already there.
 *
 * `wx` for a file and a non-recursive `mkdir` for a directory: both fail with
 * EEXIST rather than succeeding. `recursive: true` would have been wrong twice
 * over, since `name` is a single plain name so there is never a parent to
 * make, and it would also make creating an existing directory silently succeed.
 */
export async function createEntry(
  root: string,
  relDir: string,
  name: string,
  kind: 'file' | 'directory',
): Promise<FsResult> {
  const target = createTarget(root, relDir, name)
  if (target === null) return { ok: false, error: 'That name cannot be used here' }
  try {
    if (kind === 'directory') await mkdir(target)
    else await writeFile(target, '', { flag: 'wx' })
    return { ok: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return { ok: false, error: 'Something with that name is already here' }
    return { ok: false, error: error instanceof Error ? error.message : 'Could not create that' }
  }
}
