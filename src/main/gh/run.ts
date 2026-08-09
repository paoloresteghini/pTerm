import { execFile } from 'node:child_process'

const TIMEOUT_MS = 20_000

export interface GhRun {
  code: number
  stdout: string
  stderr: string
  spawnFailed: boolean
}

export type IssuesFailure =
  | 'no-repo'
  | 'no-remote'
  | 'not-github'
  | 'no-gh'
  | 'no-auth'
  | 'no-issues'
  | 'failed'

export function ghBin(): string {
  return process.env.PTERM_GH_BIN ?? 'gh'
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
        const spawnFailed = typeof raw === 'string'
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
