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

/**
 * Finds the GitHub repository behind `cwd`, or the reason it could not:
 * not inside a git repository, no `origin` remote, or a remote that is not
 * GitHub. Every issues command starts here, since none of them can name a
 * `--repo` without it.
 */
export async function resolveRepo(
  cwd: string,
): Promise<{ ok: true; ref: RepoRef } | { ok: false; reason: IssuesFailure }> {
  const root = await repoRoot(cwd)
  if (root === null) return { ok: false, reason: 'no-repo' }
  const remote = await git(root, ['remote', 'get-url', 'origin'])
  if (remote.code !== 0) return { ok: false, reason: 'no-remote' }
  const ref = parseRemote(remote.stdout)
  if (ref === null) return { ok: false, reason: 'not-github' }
  return { ok: true, ref }
}

const MESSAGES: Record<IssuesFailure, string> = {
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

/** Lists issues in the repository at `cwd`, filtered by `state`. */
export async function listIssues(
  cwd: string,
  state: IssueStateFilter,
): Promise<IssuesResult<IssueSummary[]>> {
  const resolved = await resolveRepo(cwd)
  if (!resolved.ok) return failure(resolved.reason)
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
  if (!resolved.ok) return failure(resolved.reason)
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
