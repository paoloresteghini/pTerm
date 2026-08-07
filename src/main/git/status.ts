import { basename } from 'node:path'
import { git } from './sync'
import type { GitChanges, GitFileChange } from '../../shared/ipc'

/**
 * The part of a porcelain-v2 entry after its first `tokens` space-separated
 * fields, which is the path.
 *
 * Written as an index walk rather than `split(' ')` because `-z` leaves paths
 * unquoted: a path containing spaces is still one path, and rejoining a split
 * would be guesswork about how many of the pieces were path.
 */
function tail(field: string, tokens: number): string {
  let index = 0
  for (let seen = 0; seen < tokens; seen++) {
    const next = field.indexOf(' ', index)
    if (next === -1) return ''
    index = next + 1
  }
  return field.slice(index)
}

/**
 * `git status --porcelain=v2 -z --branch --untracked-files=all` output, read
 * into the two lists the column draws.
 *
 * Pure, and exported for its own sake: spawning git to test the parsing of a
 * rename would be a slower test of the same thing, and this is the shape
 * `parseCounts` in `sync.ts` already establishes for this codebase.
 *
 * `repo` is not part of what it returns because status output does not carry
 * it. Only `readChanges`, which resolved the root to run in, knows it.
 */
export function parseStatus(stdout: string): Omit<GitChanges, 'repo'> {
  const fields = stdout.split('\0').filter((field) => field.length > 0)
  let branch: string | null = null
  let head: string | null = null
  const staged: GitFileChange[] = []
  const unstaged: GitFileChange[] = []

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]

    if (field.startsWith('# branch.head ')) {
      const name = field.slice('# branch.head '.length).trim()
      // git writes this literal for a detached HEAD. git does not forbid a
      // branch literally named '(detached)' (measured: `git branch
      // "(detached)"` succeeds), so such a branch would read identically to
      // a real detached HEAD. That ambiguity is in the porcelain format
      // itself and is accepted here as negligible.
      branch = name === '(detached)' ? null : name
      continue
    }
    if (field.startsWith('# branch.oid ')) {
      const oid = field.slice('# branch.oid '.length).trim()
      head = oid === '(initial)' ? null : oid
      continue
    }
    if (field.startsWith('#')) continue

    if (field.startsWith('? ')) {
      unstaged.push({ path: field.slice(2), staged: null, worktree: '?' })
      continue
    }
    // Ignored entries are asked for by no flag this feature passes, but git
    // will emit them if one is ever added, and a path in the list that the
    // user cannot act on is worse than one that is missing.
    if (field.startsWith('! ')) continue

    const kind = field[0]
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue

    // Field counts before the path, from git's own documented layouts:
    //   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>
    //   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    const before = kind === '1' ? 8 : kind === '2' ? 9 : 10
    const path = tail(field, before)
    if (path === '') continue

    // A rename carries its original path as the NEXT NUL-separated field.
    // Consuming it here is what stops the loop reading it as an entry.
    let renamedFrom: string | undefined
    if (kind === '2') {
      renamedFrom = fields[i + 1]
      i += 1
    }

    const x = field[2]
    const y = field[3]

    // Unmerged entries carry conflict letters on both sides. This feature has
    // no conflict UI, so such a path is shown once, as an unstaged `U`: it is
    // something to know about and nothing this panel can resolve.
    if (kind === 'u') {
      unstaged.push({ path, staged: null, worktree: 'U' })
      continue
    }

    if (x !== '.') {
      staged.push(
        renamedFrom === undefined
          ? { path, staged: x, worktree: null }
          : { path, staged: x, worktree: null, renamedFrom },
      )
    }
    if (y !== '.') unstaged.push({ path, staged: null, worktree: y })
  }

  return { branch, head, staged, unstaged }
}

/**
 * The root of the repository `cwd` is in, or null when it is not in one.
 *
 * Every git operation in this feature runs here rather than at the project's
 * `cwd`, because porcelain paths are relative to the root: a project pointed
 * at a subdirectory would otherwise get paths it cannot resolve, and a
 * containment check against `cwd` would reject every file outside it.
 */
export async function repoRoot(cwd: string): Promise<string | null> {
  const run = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (run.code !== 0) return null
  const root = run.stdout.trim()
  return root === '' ? null : root
}

/** The working tree's state, or null when `cwd` is not inside a repository. */
export async function readChanges(cwd: string): Promise<GitChanges | null> {
  const root = await repoRoot(cwd)
  if (root === null) return null
  const run = await git(root, [
    'status',
    '--porcelain=v2',
    '-z',
    '--branch',
    '--untracked-files=all',
  ])
  if (run.code !== 0) return null
  return { repo: basename(root), ...parseStatus(run.stdout) }
}
