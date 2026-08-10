import type {
  IssueDetail,
  IssueStateFilter,
  IssueSummary,
  IssuesFailure,
  IssuesResult,
} from '../../shared/ipc'
import { git } from '../git/sync'
import { repoRoot } from '../git/status'
import { classify, gh } from './run'
import { parseRemote, repoArg, type RepoRef } from './repo'

/** `gh issue list` caps out here; past it the list is a `--limit` away from complete. */
const LIMIT = 200

const LIST_FIELDS = 'number,title,state,stateReason,labels,assignees,comments,updatedAt,author'
const DETAIL_FIELDS = `${LIST_FIELDS},body,url,createdAt`

/**
 * True for a value that can safely have its properties read, i.e. an object
 * that is not `null`. `entry as SomeShape` is a compile-time-only cast and
 * does nothing at runtime, so a `null` array element sails through it and
 * throws on the first property read; every place below that reads a field
 * off an untrusted array element filters through this first.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Narrows one raw JSON row from `gh issue list` or `gh issue view` to an
 * `IssueSummary`, defaulting anything missing or mistyped rather than
 * throwing. Returns null when the row has no numeric `number`: without one
 * there is nothing to key the row on, and a coerced NaN would be worse than
 * dropping it. A `null` or non-object element inside `labels` or
 * `assignees` is dropped rather than defaulted, since there is nothing in
 * it to default from.
 */
function summary(row: Record<string, unknown>): IssueSummary | null {
  const number = row.number
  if (typeof number !== 'number') return null
  const comments = Array.isArray(row.comments) ? row.comments : []
  const labels = (Array.isArray(row.labels) ? row.labels : []).filter(isRecord)
  const assignees = (Array.isArray(row.assignees) ? row.assignees : []).filter(isRecord)
  const author = (row.author ?? {}) as { login?: unknown }
  return {
    number,
    title: typeof row.title === 'string' ? row.title : '',
    state: row.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    stateReason:
      row.stateReason === 'COMPLETED' ||
      row.stateReason === 'NOT_PLANNED' ||
      row.stateReason === 'REOPENED'
        ? row.stateReason
        : null,
    labels: labels.map((entry) => {
      const label = entry as { name?: unknown; color?: unknown }
      return {
        name: typeof label.name === 'string' ? label.name : '',
        color: typeof label.color === 'string' ? label.color : '888888',
      }
    }),
    assignees: assignees.map((entry) => {
      const user = entry as { login?: unknown }
      return { login: typeof user.login === 'string' ? user.login : '' }
    }),
    commentCount: comments.length,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    author: { login: typeof author.login === 'string' ? author.login : '' },
  }
}

/**
 * Parses a `gh issue list --json ...` reply. Never throws: malformed JSON, a
 * non-array reply, and a `null` or otherwise non-object element within an
 * array that is itself well-formed all read as a dropped row rather than
 * surfacing a parse error the caller cannot act on.
 */
export function parseSummaries(stdout: string): IssueSummary[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const rows: IssueSummary[] = []
  for (const entry of parsed) {
    if (!isRecord(entry)) continue
    const one = summary(entry)
    if (one) rows.push(one)
  }
  return rows
}

/**
 * Parses a `gh issue view --json ...` reply. Returns null on malformed
 * JSON, a non-object reply, or a row with no numeric `number`, mirroring
 * `parseSummaries`. A `null` or otherwise non-object element within
 * `comments` is dropped rather than defaulted, for the same reason a
 * malformed label or assignee is.
 */
export function parseDetail(stdout: string): IssueDetail | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const row = parsed as Record<string, unknown>
  const base = summary(row)
  if (!base) return null
  const comments = (Array.isArray(row.comments) ? row.comments : []).filter(isRecord)
  return {
    ...base,
    body: typeof row.body === 'string' ? row.body : '',
    url: typeof row.url === 'string' ? row.url : '',
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    comments: comments.map((entry) => {
      const comment = entry as { author?: { login?: unknown }; body?: unknown; createdAt?: unknown }
      return {
        author: {
          login: typeof comment.author?.login === 'string' ? comment.author.login : '',
        },
        body: typeof comment.body === 'string' ? comment.body : '',
        createdAt: typeof comment.createdAt === 'string' ? comment.createdAt : '',
      }
    }),
  }
}

/** A `resolveRepo` failure, carrying the remote when there was one to reject. */
export type RepoFailure = { ok: false; reason: IssuesFailure; remote?: string }

/**
 * Finds the GitHub repository behind `cwd`, or the reason it could not:
 * not inside a git repository, no `origin` remote, or a remote that is not
 * GitHub. Every issues command starts here, since none of them can name a
 * `--repo` without it.
 *
 * `not-github` carries the URL it rejected. The host rule is an allowlist
 * (`repo.ts`), so someone running a GitHub Enterprise Server on a host it
 * does not admit is told their GitHub remote is not GitHub; naming the URL
 * is what makes that a rule they can see rather than a contradiction of
 * `git remote -v`.
 */
export async function resolveRepo(
  cwd: string,
): Promise<{ ok: true; ref: RepoRef } | RepoFailure> {
  const root = await repoRoot(cwd)
  if (root === null) return { ok: false, reason: 'no-repo' }
  const remote = await git(root, ['remote', 'get-url', 'origin'])
  if (remote.code !== 0) return { ok: false, reason: 'no-remote' }
  const ref = parseRemote(remote.stdout)
  if (ref === null) return { ok: false, reason: 'not-github', remote: remote.stdout.trim() }
  return { ok: true, ref }
}

const MESSAGES: Record<IssuesFailure, string> = {
  'no-project': 'This project is no longer in the workspace.',
  'no-repo': 'This project is not inside a git repository.',
  'no-remote': 'This repository has no origin remote.',
  'not-github': 'The origin remote does not point at GitHub.',
  'no-gh': 'The GitHub CLI is not installed.',
  'no-auth': 'The GitHub CLI is not signed in.',
  'no-issues': 'Issues are disabled for this repository, or it cannot be read.',
  failed: 'The GitHub CLI reported an error.',
}

/**
 * Builds a failed `IssuesResult`. `detail` is `gh`'s own stderr; it is only
 * shown for the catch-all `failed` reason, where `gh`'s wording is the most
 * useful thing available. Every named reason gets a message this module
 * chose, since those cases already know what went wrong.
 */
function failure<T>(reason: IssuesFailure, detail?: string): IssuesResult<T> {
  const trimmed = detail?.trim() ?? ''
  return {
    ok: false,
    reason,
    message: reason === 'failed' && trimmed !== '' ? trimmed : MESSAGES[reason],
  }
}

/**
 * The failed `IssuesResult` for a repository that could not be resolved.
 * Everything but `not-github` is `MESSAGES` verbatim; that one names the URL
 * it rejected, for the reason `resolveRepo` gives. Falls back to the plain
 * sentence when there is no URL to name, which `resolveRepo` only produces
 * for an `origin` whose value is entirely whitespace.
 */
function repoFailure<T>(resolved: RepoFailure): IssuesResult<T> {
  if (resolved.reason === 'not-github' && resolved.remote !== undefined && resolved.remote !== '') {
    return {
      ok: false,
      reason: 'not-github',
      message: `The origin remote ${resolved.remote} does not point at GitHub.`,
    }
  }
  return failure(resolved.reason)
}

/**
 * The reply every issues IPC handler sends when the project id names nothing
 * in the workspace. Here rather than inlined at each handler so the sentence
 * the user reads is the one `MESSAGES` defines, alongside the other seven.
 */
export const NO_PROJECT: IssuesResult<never> = {
  ok: false,
  reason: 'no-project',
  message: MESSAGES['no-project'],
}

/** Lists issues in the repository at `cwd`, filtered by `state`. */
export async function listIssues(
  cwd: string,
  state: IssueStateFilter,
): Promise<IssuesResult<IssueSummary[]>> {
  const resolved = await resolveRepo(cwd)
  if (!resolved.ok) return repoFailure(resolved)
  const arg = repoArg(resolved.ref)
  const run = await gh(cwd, [
    'issue',
    'list',
    '--repo',
    arg,
    '--state',
    state,
    '--limit',
    String(LIMIT),
    '--json',
    LIST_FIELDS,
  ])
  if (run.code !== 0 || run.spawnFailed) return failure(classify(run), run.stderr)
  const value = parseSummaries(run.stdout)
  return {
    ok: true,
    repo: { slug: `${resolved.ref.owner}/${resolved.ref.name}`, arg },
    value,
    truncated: value.length >= LIMIT,
  }
}

/** Fetches one issue's full detail from the repository at `cwd`. */
export async function getIssue(cwd: string, number: number): Promise<IssuesResult<IssueDetail>> {
  const resolved = await resolveRepo(cwd)
  if (!resolved.ok) return repoFailure(resolved)
  const arg = repoArg(resolved.ref)
  const run = await gh(cwd, ['issue', 'view', String(number), '--repo', arg, '--json', DETAIL_FIELDS])
  if (run.code !== 0 || run.spawnFailed) return failure(classify(run), run.stderr)
  const value = parseDetail(run.stdout)
  if (value === null) return failure('failed', 'Could not read the issue.')
  return {
    ok: true,
    repo: { slug: `${resolved.ref.owner}/${resolved.ref.name}`, arg },
    value,
    truncated: false,
  }
}

/**
 * The argv for `gh issue close` or `gh issue reopen`, split out so it can be
 * asserted without spawning anything.
 *
 * `reason` is only ever appended for `close`: `gh issue reopen` has no
 * `--reason` flag of its own. `'not planned'` carries a space and is passed
 * as one argv element regardless, since `gh` (via `execFile`) is never run
 * through a shell and there is nothing here that needs escaping.
 */
export function issueArgs(
  action: 'close' | 'reopen',
  number: number,
  arg: string,
  reason?: 'completed' | 'not planned',
): string[] {
  const args = ['issue', action, String(number), '--repo', arg]
  if (action === 'close' && reason !== undefined) args.push('--reason', reason)
  return args
}

/**
 * Shared shape behind every mutation below: resolve the repository, build
 * the command against it, run `gh`, and read the result.
 *
 * `build` gets the resolved `--repo` argument and returns both the argv and
 * an optional stdin, so a caller that needs neither (`setIssueState`) can
 * leave stdin out rather than passing an empty string `gh` would see as a
 * blank body.
 */
async function mutate<T>(
  cwd: string,
  build: (arg: string) => { args: string[]; stdin?: string },
  read: (run: { stdout: string }) => T,
): Promise<IssuesResult<T>> {
  const resolved = await resolveRepo(cwd)
  if (!resolved.ok) return repoFailure(resolved)
  const arg = repoArg(resolved.ref)
  const built = build(arg)
  const run = await gh(cwd, built.args, built.stdin)
  if (run.code !== 0 || run.spawnFailed) return failure(classify(run), run.stderr)
  return {
    ok: true,
    repo: { slug: `${resolved.ref.owner}/${resolved.ref.name}`, arg },
    value: read(run),
    truncated: false,
  }
}

/** Closes or reopens an issue in the repository at `cwd`. */
export function setIssueState(
  cwd: string,
  number: number,
  action: 'close' | 'reopen',
  reason?: 'completed' | 'not planned',
): Promise<IssuesResult<true>> {
  return mutate(cwd, (arg) => ({ args: issueArgs(action, number, arg, reason) }), () => true)
}

/**
 * Adds a comment to an issue in the repository at `cwd`.
 *
 * `body` goes over stdin via `--body-file -`, never `--body <string>`: argv
 * has a length ceiling and a comment is unbounded markdown.
 */
export function commentIssue(cwd: string, number: number, body: string): Promise<IssuesResult<true>> {
  return mutate(
    cwd,
    (arg) => ({
      args: ['issue', 'comment', String(number), '--repo', arg, '--body-file', '-'],
      stdin: body,
    }),
    () => true,
  )
}

/** Rewrites an issue's title and body in the repository at `cwd`. */
export function editIssue(
  cwd: string,
  number: number,
  title: string,
  body: string,
): Promise<IssuesResult<true>> {
  return mutate(
    cwd,
    (arg) => ({
      args: ['issue', 'edit', String(number), '--repo', arg, '--title', title, '--body-file', '-'],
      stdin: body,
    }),
    () => true,
  )
}

/**
 * The new issue's number, read out of the URL `gh issue create` prints on
 * stdout. `0` for anything that does not end in `/issues/<digits>`: an empty
 * reply, a URL with no number, or extra output after it.
 *
 * A named function rather than a regex inline in `createIssue` so its edge
 * cases can be asserted directly, without a stub `gh` and a launched app
 * between the test and the branch it is about.
 */
export function issueNumberFromUrl(stdout: string): number {
  const match = /\/issues\/(\d+)\s*$/.exec(stdout.trim())
  return match ? Number(match[1]) : 0
}

/**
 * Opens a new issue in the repository at `cwd`, answering with its number.
 *
 * `gh issue create` prints the new issue's URL on stdout rather than JSON,
 * unlike every other command in this file, which is why the number is read
 * out of the URL's last path segment instead of parsed as JSON. `0` means
 * the issue was created but the number could not be read from the URL; the
 * caller refetches the list either way, so this is a display detail rather
 * than a failure.
 */
export function createIssue(cwd: string, title: string, body: string): Promise<IssuesResult<number>> {
  return mutate(
    cwd,
    (arg) => ({
      args: ['issue', 'create', '--repo', arg, '--title', title, '--body-file', '-'],
      stdin: body,
    }),
    (run) => issueNumberFromUrl(run.stdout),
  )
}
