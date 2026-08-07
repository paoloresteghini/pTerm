import { unlink } from 'node:fs/promises'
import { relative, resolve, sep, join } from 'node:path'
import { git, describeFailure } from './sync'
import { readChanges } from './status'
import type { DiffSide, GitMutation } from '../../shared/ipc'

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

/**
 * Undo the working-tree changes to `paths`.
 *
 * Two operations wearing one label, and the difference is not cosmetic. A
 * tracked file is restored from the index, which is reversible only in the
 * sense that the content came from somewhere. An untracked file has no
 * committed state to return to, so discarding it means deleting it, and
 * nothing anywhere can bring it back.
 *
 * `expectedUntracked` is which of `paths` the confirm dialog told the user
 * would be DELETED, as opposed to restored. The renderer snapshots that
 * split when the dialog OPENS and sends the snapshot unchanged
 * (`PendingDiscard` in `src/renderer/GitPanel.tsx`), so what arrives here is
 * genuinely what was read, not a re-read taken at click time. It is checked
 * against a fresh status read taken here, and the whole batch is refused if
 * the two disagree on even one path, rather than silently acting on the
 * fresh classification. Several sessions can share one checkout, so a path
 * shown as restorable can become untracked (a peer's `rm --cached`, say)
 * between the dialog opening and the click landing; acting on the fresh read
 * in that case would delete something the user was told would survive.
 * Refusing and handing back the current list, the same shape `commit`
 * refuses in when the branch moved underneath it, is what fails safe.
 */
export async function discard(
  root: string,
  paths: string[],
  expectedUntracked: string[],
): Promise<GitMutation> {
  const safe = safePaths(root, paths)
  if (safe.length === 0) return failed(root, 'Nothing to discard')

  const before = await readChanges(root)
  if (before === null) return { ok: false, error: 'Not a git repository', changes: null }

  const untracked = new Set(
    before.unstaged.filter((c) => c.worktree === '?').map((c) => c.path),
  )
  const expected = new Set(expectedUntracked)
  const changed = safe.some((path) => untracked.has(path) !== expected.has(path))
  if (changed) {
    return failed(
      root,
      'The list changed since it was shown. Nothing was discarded; review and try again.',
    )
  }

  const toDelete = safe.filter((path) => untracked.has(path))
  const toRestore = safe.filter((path) => !untracked.has(path))

  if (toRestore.length > 0) {
    const run = await git(root, ['restore', '--', ...toRestore])
    if (run.code !== 0) return failed(root, describeFailure(run.stderr, run.stdout))
  }

  const deleteErrors: string[] = []
  for (const path of toDelete) {
    try {
      await unlink(join(root, path))
    } catch (error) {
      // ENOENT means the file is already gone, which is the state the
      // caller asked for. Anything else (permissions, say) is a real
      // failure and must be surfaced the same way a failed restore above
      // is, rather than swallowed into a row that is just still there after
      // the refresh with no explanation why.
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      if (code !== 'ENOENT') {
        deleteErrors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (deleteErrors.length > 0) return failed(root, `Could not delete ${deleteErrors.join('; ')}`)

  return settled(root)
}

/**
 * Stash everything, untracked included.
 *
 * No confirm, unlike discard: a stash is recoverable, and `git stash list` is
 * where it is recovered from. Popping is deliberately not offered here.
 */
export async function stashAll(root: string): Promise<GitMutation> {
  return operate(root, ['stash', 'push', '--include-untracked'])
}

/**
 * The unified diff for one path, as text.
 *
 * Untracked files get `--no-index` against /dev/null, which is how git itself
 * renders a wholly new file, so the pane's renderer has one format to read
 * rather than two. That invocation exits 1 when the files differ, which for
 * this call is the normal case and not a failure.
 */
export async function diffOf(
  root: string,
  path: string,
  side: DiffSide,
): Promise<string | null> {
  const safe = safePaths(root, [path])
  if (safe.length === 0) return null
  const only = safe[0]

  const status = await readChanges(root)
  const untracked =
    status?.unstaged.some((c) => c.path === only && c.worktree === '?') ?? false

  if (untracked) {
    const run = await git(root, ['diff', '--no-index', '--', '/dev/null', only])
    // `--no-index` exits 1 when the two differ, which is every use of it here.
    return run.code === 0 || run.code === 1 ? run.stdout : null
  }

  const args =
    side === 'staged' ? ['diff', '--cached', '--', only] : ['diff', '--', only]
  const run = await git(root, args)
  return run.code === 0 ? run.stdout : null
}
