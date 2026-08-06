import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * What `.git/HEAD` says the checkout is on, or null when the file says nothing
 * a bar can show.
 *
 * Two shapes exist. On a branch the file holds `ref: refs/heads/<name>`; the
 * name is everything after that prefix and can itself contain slashes
 * (`feature/foo`), so this takes the remainder rather than the last segment.
 * Detached, it holds a bare object id, which gets abbreviated the way git
 * itself abbreviates in `git status` output.
 *
 * A symbolic ref pointing outside `refs/heads/` is neither, and returns null: a
 * bar reading "current branch" has no honest thing to put there.
 */
export function branchFromHead(head: string): string | null {
  const text = head.trim()
  const onBranch = /^ref:\s*refs\/heads\/(.+)$/.exec(text)
  if (onBranch) return onBranch[1].trim() || null
  if (/^[0-9a-f]{7,40}$/i.test(text)) return text.slice(0, 7)
  return null
}

/**
 * The directory holding `HEAD` for the repository `cwd` sits in, or null when
 * no ancestor is a checkout.
 *
 * Walks up because a project's cwd is wherever the user pointed it, which is
 * often a subdirectory of the repository rather than its root.
 *
 * `.git` is a directory in an ordinary clone and a file in a linked worktree or
 * a submodule, where it holds `gitdir: <path>` naming the real one. That path
 * is relative to the directory the file is in when it is not absolute.
 */
async function gitDir(cwd: string): Promise<string | null> {
  let dir = resolve(cwd)
  for (;;) {
    const dot = join(dir, '.git')
    try {
      const stats = await lstat(dot)
      if (stats.isDirectory()) return dot
      if (stats.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dot, 'utf8'))
        if (!pointer) return null
        const target = pointer[1].trim()
        return isAbsolute(target) ? target : resolve(dir, target)
      }
    } catch {
      // Nothing named `.git` here, or it is unreadable. Either way this
      // directory is not the answer and the parent still might be.
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The branch `cwd` is on, or null when it is not in a repository.
 *
 * Reads `HEAD` rather than shelling out to git: this runs on a timer while the
 * window is open, and a spawn per tick for one small file is a cost with
 * nothing to show for it. It also means no dependency on git being installed.
 */
export async function readBranch(cwd: string): Promise<string | null> {
  const dir = await gitDir(cwd)
  if (!dir) return null
  try {
    return branchFromHead(await readFile(join(dir, 'HEAD'), 'utf8'))
  } catch {
    return null
  }
}
