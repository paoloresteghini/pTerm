import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * Every file in a project, for the palette's fuzzy open.
 *
 * `git ls-files` first, because every project here is a repo and it applies
 * `.gitignore` exactly, without this file reimplementing gitignore's negation
 * and precedence rules. A project that is not a repo falls back to a walk with
 * the same `{.git, node_modules}` filter the tree uses, which is thin but no
 * worse than the tree already is.
 *
 * A snapshot per call, with no watcher. The palette fetches on open, the way it
 * already fetches skills, and a stale entry costs one failed open.
 */

/** More than a fuzzy list is useful for, and enough that no real repo hits it. */
export const MAX_FILES = 20_000

export interface ProjectFiles {
  /** Paths relative to the project root, in git's order. */
  files: string[]
  /** Whether `MAX_FILES` cut the list short. Surfaced, never silent. */
  truncated: boolean
}

/**
 * Split `git ls-files -z` output into paths.
 *
 * `-z` is not a detail: a path may contain a newline on every filesystem this
 * runs on, and a line-based read turns one such path into two, both of which
 * then fail to open. It also turns OFF git's quoting of unusual names, so what
 * arrives is the literal path and must not be unescaped again.
 *
 * git writes a trailing NUL after the last entry, so the split leaves an empty
 * final element that would otherwise render as a blank palette row.
 */
export function parseLsFiles(stdout: string): string[] {
  return stdout.split('\0').filter((path) => path.length > 0)
}

/** Cut to `MAX_FILES`, saying whether anything was cut. */
export function capPaths(paths: string[]): ProjectFiles {
  return { files: paths.slice(0, MAX_FILES), truncated: paths.length > MAX_FILES }
}

/**
 * `--cached --others --exclude-standard`: tracked files plus untracked ones
 * that are not ignored. Without `--others` a file created a minute ago would
 * be missing from the palette, which is exactly when it is being looked for.
 *
 * Resolves null when git is not there, the directory is not a repo, or the
 * command fails for any other reason. The caller falls back to walking.
 */
function listWithGit(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      // A large repo's list is megabytes; the default 1MB buffer would truncate
      // it into a parse error rather than a short list.
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null)
        resolve(parseLsFiles(stdout))
      },
    )
  })
}

/** Directories never worth walking into, matching `files/tree.ts`. */
const SKIP: ReadonlySet<string> = new Set(['.git', 'node_modules'])

/**
 * The fallback for a project that is not a repo.
 *
 * Breadth-limited by `MAX_FILES` as it goes rather than after the fact, so a
 * directory tree that is enormous or circular through symlinks cannot make
 * this run forever. Symlinked directories are not followed at all, which is
 * the cheap answer to a loop.
 */
async function walk(root: string): Promise<string[]> {
  const found: string[] = []
  const queue: string[] = [root]
  while (queue.length > 0 && found.length <= MAX_FILES) {
    const dir = queue.shift() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory: a leaf that does not open, like `listDir`.
      continue
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile()) found.push(relative(root, full))
      if (found.length > MAX_FILES) break
    }
  }
  return found
}

/** Every file in `root`, by whichever route works. */
export async function projectFiles(root: string): Promise<ProjectFiles> {
  const fromGit = await listWithGit(root)
  return capPaths(fromGit ?? (await walk(root)))
}
