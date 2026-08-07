import { relative, resolve, sep } from 'node:path'
import { git, describeFailure } from './sync'
import { readChanges } from './status'
import type { GitMutation } from '../../shared/ipc'

/**
 * The subset of `paths` that really are inside `root`, normalised and made
 * relative to it.
 *
 * The renderer sends paths it read out of a status reply, so in practice they
 * are already repo-relative and already inside. This exists for the case where
 * they are not: a path is a string crossing an IPC boundary, and `git add` run
 * with `../../` in it would reach outside the repository the user is looking
 * at. Anything that does not resolve inside is dropped rather than rejected,
 * so one bad path cannot fail an operation on five good ones.
 */
export function safePaths(root: string, paths: string[]): string[] {
  const base = resolve(root)
  const kept: string[] = []
  for (const path of paths) {
    if (path === '') continue
    const full = resolve(base, path)
    // `relative` rather than `startsWith`: a bare prefix test reads
    // '/repository' as inside '/repo'. An empty result means the path IS the
    // root, which is not a file to act on.
    const rel = relative(base, full)
    if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) continue
    kept.push(rel)
  }
  return kept
}

/** The list as it now stands, wrapped as a successful mutation. */
async function settled(root: string): Promise<GitMutation> {
  const changes = await readChanges(root)
  return changes === null
    ? { ok: false, error: 'Not a git repository', changes: null }
    : { ok: true, changes }
}

/** That same list, wrapped as a failure carrying git's own words. */
async function failed(root: string, error: string): Promise<GitMutation> {
  return { ok: false, error, changes: await readChanges(root) }
}

/**
 * Run one git command and answer with the list as it stands afterwards.
 *
 * The list travels with every answer, success or failure, because the renderer
 * replaces its state from the reply rather than patching its own copy: a
 * failed stage must leave the row exactly where it was, and only a fresh read
 * can say where that is.
 */
async function operate(root: string, args: string[]): Promise<GitMutation> {
  const run = await git(root, args)
  if (run.code !== 0) return failed(root, describeFailure(run.stderr, run.stdout))
  return settled(root)
}

export async function stage(root: string, paths: string[]): Promise<GitMutation> {
  const safe = safePaths(root, paths)
  if (safe.length === 0) return failed(root, 'Nothing to stage')
  return operate(root, ['add', '--', ...safe])
}

export async function unstage(root: string, paths: string[]): Promise<GitMutation> {
  const safe = safePaths(root, paths)
  if (safe.length === 0) return failed(root, 'Nothing to unstage')
  return operate(root, ['restore', '--staged', '--', ...safe])
}

/**
 * Commit, refusing if the repository moved since the list was read.
 *
 * `expected` is the branch and head the column was showing. Several sessions
 * share these checkouts, and a commit that lands on a branch the user was not
 * looking at is a failure that leaves no trace and no error, so the cheap
 * re-read is worth it.
 *
 * With something staged, only that is committed. With nothing staged, every
 * TRACKED change is, which is the fallback VS Code offers and which keeps the
 * common case one click. Untracked files are never swept in either way: `-a`
 * does not add them, and that is deliberate rather than incidental.
 */
export async function commit(
  root: string,
  message: string,
  expected: { branch: string | null; head: string | null },
): Promise<GitMutation> {
  if (message.trim() === '') return failed(root, 'Enter a commit message')

  const now = await readChanges(root)
  if (now === null) return { ok: false, error: 'Not a git repository', changes: null }
  if (now.branch !== expected.branch || now.head !== expected.head) {
    return {
      ok: false,
      error: 'The branch moved underneath you. The list has been refreshed.',
      changes: now,
    }
  }
  if (now.staged.length === 0 && now.unstaged.length === 0) {
    return { ok: false, error: 'Nothing to commit', changes: now }
  }

  const args =
    now.staged.length > 0 ? ['commit', '-m', message] : ['commit', '-a', '-m', message]
  return operate(root, args)
}
