import { execFile } from 'node:child_process'
import type { IssuesFailure } from '../../shared/ipc'

export type { IssuesFailure }

const TIMEOUT_MS = 20_000

export interface GhRun {
  code: number
  stdout: string
  stderr: string
  spawnFailed: boolean
}

export function ghBin(): string {
  return process.env.PTERM_GH_BIN ?? 'gh'
}

/**
 * The `error.code` values Node reports when the child could never be started
 * at all: no such binary, not executable, a path component that is not a
 * directory. `classify` turns these into `no-gh`, which is the one message
 * that tells the user to install `gh`.
 *
 * Matched by name rather than by `typeof code === 'string'`, which is what
 * this used to do. Node also reports `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` as
 * a string `code` when a reply overruns `maxBuffer` below, and that comes
 * from a `gh` that spawned and ran perfectly well; reading it as "gh could
 * not be spawned" told a user with a working CLI to install one. A timeout
 * is unaffected either way: it yields `code: null`.
 */
const SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'ENOTDIR'])

/**
 * Whether an `execFile` error's `code` says the child never started. Exported
 * only so the rule above can be asserted directly: reaching the maxBuffer
 * case through `gh()` itself would mean a 32MB reply in a unit test.
 */
export function isSpawnFailure(code: unknown): boolean {
  return typeof code === 'string' && SPAWN_CODES.has(code)
}

export function gh(cwd: string, args: string[], stdin?: string): Promise<GhRun> {
  return new Promise((resolve) => {
    const child = execFile(
      ghBin(),
      args,
      {
        cwd,
        timeout: TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          NO_COLOR: '1',
        },
      },
      (error, stdout, stderr) => {
        const raw = (error as { code?: unknown } | null)?.code
        const spawnFailed = isSpawnFailure(raw)
        const code = error === null ? 0 : typeof raw === 'number' ? raw : 1
        resolve({ code, stdout, stderr, spawnFailed })
      },
    )
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

export function classify(run: GhRun): IssuesFailure {
  if (run.spawnFailed) return 'no-gh'
  const stderr = run.stderr.toLowerCase()
  if (
    stderr.includes('gh auth login') ||
    stderr.includes('authentication') ||
    stderr.includes('not logged') ||
    stderr.includes('bad credentials') ||
    stderr.includes('http 401')
  ) {
    return 'no-auth'
  }
  if (
    stderr.includes('could not resolve to a repository') ||
    stderr.includes('issues" tab is disabled') ||
    stderr.includes('issues are disabled') ||
    stderr.includes('http 404')
  ) {
    return 'no-issues'
  }
  return 'failed'
}
