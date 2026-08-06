import { execFile } from 'node:child_process'

/** How long any one git invocation gets before it is killed. */
const TIMEOUT_MS = 60_000

export interface GitRun {
  code: number
  stdout: string
  stderr: string
}

/**
 * One git invocation in `cwd`, reported rather than thrown.
 *
 * `GIT_TERMINAL_PROMPT=0` because this runs inside a GUI app with no terminal
 * attached: a remote that wants credentials would otherwise leave git waiting
 * on a prompt nobody can see or answer. With it, git fails immediately and the
 * bar gets a message. The timeout is the backstop for whatever asks for input
 * some other way.
 *
 * A non-zero exit is an ordinary result here, not an exception: every caller
 * has something to say about it, and the two "failures" that matter most —
 * no upstream configured, and a branch that will not fast-forward — are both
 * expected states rather than bugs.
 */
export function git(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        // `error.code` is the exit status for a normal failure and a string
        // like 'ENOENT' when git itself could not be run. Anything that is not
        // a number is reported as 1, which every caller treats as "no answer".
        const code =
          error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code)
            : 1
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/**
 * How far the checkout is from its upstream, or null when the counts cannot be
 * had.
 *
 * `git rev-list --left-right --count @{u}...HEAD` prints two numbers: commits
 * reachable from the upstream only, then from HEAD only. Left is therefore
 * behind and right is ahead.
 */
export function parseCounts(stdout: string): { behind: number; ahead: number } | null {
  const match = /^(\d+)\s+(\d+)$/.exec(stdout.trim())
  if (!match) return null
  return { behind: Number(match[1]), ahead: Number(match[2]) }
}

/**
 * The line of a failed git run worth putting in a 22px bar.
 *
 * Prefers git's own `fatal:`/`error:` line: a failed `pull` writes the fetch's
 * progress to stderr first, so the first line is usually "From /path/to/remote"
 * and the reason is further down. Falls back to the first non-empty line.
 */
export function describeFailure(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? 'git failed'
}

/**
 * Ahead/behind for the branch at `cwd`, or null when there is nothing to count
 * against: no repository, no upstream for the current branch, or no git.
 *
 * Reads local refs only — no fetch — so this is safe to run on a timer. It
 * means the behind count is as old as the last fetch, which for this app is
 * the last time the user pressed Sync.
 */
export async function readCounts(cwd: string): Promise<{ behind: number; ahead: number } | null> {
  const run = await git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
  if (run.code !== 0) return null
  return parseCounts(run.stdout)
}

export type SyncResult = { ok: true } | { ok: false; error: string }

/**
 * Fetch, fast-forward, push — stopping at the first thing that fails.
 *
 * `--ff-only` rather than a plain `pull`: a bar button is a poor place to
 * decide that a diverged branch should get a merge commit, and this app exists
 * to run many agents against the same checkouts. Diverged means the user is
 * told and nothing is written.
 */
export async function syncBranch(cwd: string): Promise<SyncResult> {
  for (const args of [['fetch'], ['pull', '--ff-only'], ['push']]) {
    const run = await git(cwd, args)
    if (run.code !== 0) return { ok: false, error: describeFailure(run.stderr, run.stdout) }
  }
  return { ok: true }
}
