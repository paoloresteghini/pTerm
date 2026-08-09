# Issues Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an eighth side column listing the active project's GitHub issues, backed by the `gh` CLI, with a modal for reading, creating, editing, commenting and closing, and rename the Git column to "Git Changes".

**Architecture:** A new `src/main/gh/` directory mirroring `src/main/git/`: a thin `execFile` wrapper, a pure remote-URL parser, a pure failure classifier, and a command layer. The renderer gets one new column component and one new modal, plus pure list logic in `src/renderer/lib/` so it is testable under this repo's DOM-less vitest. No new `TabType`, no new `PaneRecord` type, no restore surface.

**Tech Stack:** Electron + React + TypeScript, Tailwind, Radix Dialog, CodeMirror 6 (`@codemirror/lang-markdown`, already a dependency), vitest (`environment: 'node'`), Playwright for Electron e2e. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-09-issues-panel-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **No em dashes anywhere.** Not in code, comments, copy, test names, or commit messages. Restructure with commas, colons, parentheses, or separate sentences. Hyphens in compound words and ranges are fine.
- **Do not copy comment text out of this plan into the code.** Code blocks below are deliberately comment-free. Write comments yourself, and verify each claim against the branch as it stands at the moment you write it, not against this document. A comment that was true when the plan was written can be false three tasks later.
- **No `data-testid` in this feature may begin with `tab-`.** 27+ e2e locators count open tabs by `[data-testid^="tab-"]` and would count these instead.
- **Unit tests run under `environment: 'node'`** (`vitest.config.mts`). They cannot import React, touch the DOM, or render a component. Anything that needs testing must be a pure function in its own module.
- **Every `gh` invocation passes `--repo`.** No exceptions. `gh` left to resolve a base repository itself will prompt inside a fork, and a prompt spawned from Electron is a hang.
- **Never use a shell.** `execFile` only, argv arrays only. A value containing a space (`not planned`) is one argv element and carries no quote characters.
- **No new npm dependencies.** If a task seems to need one, stop and raise it.
- **Verified environment:** `gh version 2.96.0 (2026-07-02)`. All `--json` field names and flags used below were checked against it on 2026-08-09.
- **Before every commit:** `npm run typecheck` and `npm test` must both pass. Include their output in the task report.
- **Commit at the end of every task.** Do not batch two tasks into one commit.

---

### Task 1: Parse a GitHub remote URL into a repository reference

**Files:**
- Create: `src/main/gh/repo.ts`
- Create: `tests/unit/ghRepo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface RepoRef { host: string; owner: string; name: string }` and `export function parseRemote(url: string): RepoRef | null` and `export function repoArg(ref: RepoRef): string`.

`repoArg` returns the string handed to `gh --repo`: `OWNER/NAME` when the host is `github.com`, and `HOST/OWNER/NAME` otherwise, which is the `[HOST/]OWNER/REPO` form `gh` documents.

**A host counts as GitHub only on a dot boundary**, compared lowercased: exactly `github.com`, or a suffix of `.github.com` or `.ghe.com`. A prefix test such as `host.startsWith('github.')` looks equivalent and is not. `github.com.attacker.net` is a wholly separate registrable domain, and accepting it feeds an attacker-chosen host into `gh --repo HOST/OWNER/REPO`. An earlier draft of this plan specified the prefix test, an implementer transcribed it faithfully, and review caught it. Likewise the path must be **exactly two** segments: taking the last two of a longer path resolves `https://github.com/owner/repo/blob/main/file.ts` to a repository called `main/file.ts`.

This rejects self-hosted Enterprise hosts on arbitrary domains, which the design document originally promised. That narrowing is deliberate and is recorded in the spec.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ghRepo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseRemote, repoArg } from '../../src/main/gh/repo'

describe('parseRemote', () => {
  it('reads the scp-like SSH form', () => {
    expect(parseRemote('git@github.com:paoloresteghini/PRCLI.git')).toEqual({
      host: 'github.com',
      owner: 'paoloresteghini',
      name: 'PRCLI',
    })
  })

  it('reads the HTTPS form', () => {
    expect(parseRemote('https://github.com/paoloresteghini/PRCLI.git')).toEqual({
      host: 'github.com',
      owner: 'paoloresteghini',
      name: 'PRCLI',
    })
  })

  it('reads the ssh:// form', () => {
    expect(parseRemote('ssh://git@github.com/paoloresteghini/PRCLI')).toEqual({
      host: 'github.com',
      owner: 'paoloresteghini',
      name: 'PRCLI',
    })
  })

  it('tolerates a missing .git suffix and a trailing slash and newline', () => {
    expect(parseRemote('https://github.com/o/n/\n')).toEqual({
      host: 'github.com',
      owner: 'o',
      name: 'n',
    })
  })

  it('keeps a GitHub Enterprise Cloud host', () => {
    expect(parseRemote('git@enterprise.github.com:team/thing.git')).toEqual({
      host: 'enterprise.github.com',
      owner: 'team',
      name: 'thing',
    })
  })

  it('rejects a spoofed-prefix host', () => {
    expect(parseRemote('git@github.com.attacker.net:owner/name.git')).toBeNull()
  })

  it('rejects a similar-prefix host', () => {
    expect(parseRemote('https://github.evil.net/owner/name.git')).toBeNull()
  })

  it('rejects a URL with extra path segments', () => {
    expect(parseRemote('https://github.com/owner/repo/blob/main/file.ts')).toBeNull()
  })

  it('accepts a host in any case', () => {
    expect(parseRemote('git@GITHUB.COM:owner/name.git')?.owner).toBe('owner')
  })

  it('rejects a non-GitHub host', () => {
    expect(parseRemote('git@gitlab.com:o/n.git')).toBeNull()
  })

  it('rejects a local path with no host', () => {
    expect(parseRemote('/Users/paolo/Code/PRCLI')).toBeNull()
  })

  it('rejects a URL with no owner segment', () => {
    expect(parseRemote('https://github.com/onlyone')).toBeNull()
  })

  it('rejects empty input', () => {
    expect(parseRemote('')).toBeNull()
  })
})

describe('repoArg', () => {
  it('omits github.com', () => {
    expect(repoArg({ host: 'github.com', owner: 'o', name: 'n' })).toBe('o/n')
  })

  it('keeps an Enterprise host', () => {
    expect(repoArg({ host: 'gh.corp', owner: 'o', name: 'n' })).toBe('gh.corp/o/n')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ghRepo.test.ts`
Expected: FAIL, cannot resolve `../../src/main/gh/repo`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/gh/repo.ts`:

```ts
export interface RepoRef {
  host: string
  owner: string
  name: string
}

function isGitHubHost(host: string): boolean {
  const lower = host.toLowerCase()
  return lower === 'github.com' || lower.endsWith('.github.com') || lower.endsWith('.ghe.com')
}

export function parseRemote(url: string): RepoRef | null {
  const trimmed = url.trim()
  if (trimmed === '') return null

  let host: string
  let path: string

  const scp = /^(?:([^@/]+)@)?([^@/:]+):(.+)$/.exec(trimmed)
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)

  if (!scheme && scp) {
    host = scp[2]
    path = scp[3]
  } else if (scheme) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    host = parsed.hostname
    path = parsed.pathname
  } else {
    return null
  }

  if (!isGitHubHost(host)) return null

  const segments = path
    .replace(/\.git$/, '')
    .split('/')
    .filter((segment) => segment !== '')
  if (segments.length !== 2) return null

  const [owner, name] = segments

  return { host, owner, name }
}

export function repoArg(ref: RepoRef): string {
  return ref.host.toLowerCase() === 'github.com'
    ? `${ref.owner}/${ref.name}`
    : `${ref.host}/${ref.owner}/${ref.name}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ghRepo.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
npm test
git add src/main/gh/repo.ts tests/unit/ghRepo.test.ts
git commit -m "Parse a git remote URL into the repository gh --repo wants"
```

---

### Task 2: The `gh` wrapper and the failure classifier

**Files:**
- Create: `src/main/gh/run.ts`
- Create: `tests/unit/ghClassify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface GhRun { code: number; stdout: string; stderr: string; spawnFailed: boolean }`
  - `export function gh(cwd: string, args: string[], stdin?: string): Promise<GhRun>`
  - `export type IssuesFailure = 'no-project' | 'no-repo' | 'no-remote' | 'not-github' | 'no-gh' | 'no-auth' | 'no-issues' | 'failed'`
  - `export function classify(run: GhRun): IssuesFailure`

`classify` only ever returns the four reasons a `gh` run itself can produce (`no-gh`, `no-auth`, `no-issues`, `failed`). The other three are decided before `gh` is spawned, in Task 3.

`spawnFailed` is a separate flag rather than a sentinel exit code because a `gh` that could not be executed and a `gh` that exited non-zero are different states and the exit code cannot distinguish them.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ghClassify.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classify, type GhRun } from '../../src/main/gh/run'

function run(over: Partial<GhRun>): GhRun {
  return { code: 1, stdout: '', stderr: '', spawnFailed: false, ...over }
}

describe('classify', () => {
  it('reports a missing binary', () => {
    expect(classify(run({ spawnFailed: true }))).toBe('no-gh')
  })

  it('reports missing authentication', () => {
    const stderr = 'To get started with GitHub CLI, please run: gh auth login'
    expect(classify(run({ stderr }))).toBe('no-auth')
  })

  it('reports an expired or rejected token', () => {
    expect(classify(run({ stderr: 'HTTP 401: Bad credentials' }))).toBe('no-auth')
  })

  it('reports issues being disabled', () => {
    const stderr = 'GraphQL: Could not resolve to a Repository with the name o/n.'
    expect(classify(run({ stderr }))).toBe('no-issues')
  })

  it('reports an explicit issues-disabled message', () => {
    expect(classify(run({ stderr: 'the "Issues" tab is disabled' }))).toBe('no-issues')
  })

  it('falls through to a generic failure', () => {
    expect(classify(run({ stderr: 'dial tcp: lookup github.com: no such host' }))).toBe('failed')
  })

  it('does not read a successful run as a failure reason it cannot justify', () => {
    expect(classify(run({ code: 0 }))).toBe('failed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ghClassify.test.ts`
Expected: FAIL, cannot resolve `../../src/main/gh/run`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/gh/run.ts`:

```ts
import { execFile } from 'node:child_process'

const TIMEOUT_MS = 20_000

export interface GhRun {
  code: number
  stdout: string
  stderr: string
  spawnFailed: boolean
}

export type IssuesFailure =
  | 'no-project'
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ghClassify.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
npm test
git add src/main/gh/run.ts tests/unit/ghClassify.test.ts
git commit -m "Add the gh wrapper and its failure classifier"
```

---

### Task 3: Shared types and the read commands

**Files:**
- Create: `src/main/gh/issues.ts`
- Create: `tests/unit/ghIssues.test.ts`
- Modify: `src/shared/ipc.ts` (add types near the `GitChanges` block around line 692, add channels to the `CHANNELS` object after `columnsVisible` around line 80, add methods to `PTermApi`)

**Interfaces:**
- Consumes: `parseRemote`, `repoArg`, `RepoRef` from Task 1. `gh`, `classify`, `IssuesFailure`, `GhRun` from Task 2. `repoRoot(cwd)` from `src/main/git/status.ts` and `git(cwd, args)` from `src/main/git/sync.ts`, both already in the codebase.
- Produces, exported from `src/shared/ipc.ts`:

```ts
export interface IssueLabel {
  name: string
  color: string
}

export interface IssueUser {
  login: string
}

export interface IssueComment {
  author: IssueUser
  body: string
  createdAt: string
}

export type IssueState = 'OPEN' | 'CLOSED'
export type IssueStateReason = 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | null

export interface IssueSummary {
  number: number
  title: string
  state: IssueState
  stateReason: IssueStateReason
  labels: IssueLabel[]
  assignees: IssueUser[]
  commentCount: number
  updatedAt: string
  author: IssueUser
}

export interface IssueDetail extends IssueSummary {
  body: string
  url: string
  createdAt: string
  comments: IssueComment[]
}

export interface IssueRepo {
  slug: string
  arg: string
}

export type IssuesResult<T> =
  | { ok: true; repo: IssueRepo; value: T; truncated: boolean }
  | { ok: false; reason: IssuesFailure; message: string }

export type IssueStateFilter = 'open' | 'closed' | 'all'
```

  and from `src/main/gh/issues.ts`: `export function parseSummaries(stdout: string): IssueSummary[]`, `export function parseDetail(stdout: string): IssueDetail | null`, `export function resolveRepo(cwd: string): Promise<{ ok: true; ref: RepoRef } | { ok: false; reason: IssuesFailure }>`, `export function listIssues(cwd: string, state: IssueStateFilter): Promise<IssuesResult<IssueSummary[]>>`, `export function getIssue(cwd: string, number: number): Promise<IssuesResult<IssueDetail>>`.

`slug` is `owner/name` for display in the heading. `arg` is what `repoArg` produced, which is what goes to `--repo`. Two fields because they differ on Enterprise hosts and the heading should not show the host.

`IssuesFailure` is re-exported from `src/shared/ipc.ts` so the renderer can name the reasons without importing from `src/main`.

**Two facts measured against `gh` 2.96.0 and a live repository on 2026-08-09, not assumed.** `state` arrives as the literal `OPEN` or `CLOSED`. `stateReason` arrives as `COMPLETED`, `NOT_PLANNED`, or **the empty string** for an open issue, never `null`. The parser below maps anything outside the three known values to `null`, so the empty string is handled, but a test asserts it explicitly because an implementation that checked `stateReason !== null` to mean "is closed" would read every open issue as closed.

`gh` also returns more per label and per user than this model keeps (`id`, `description`, `is_bot`, `name`). Narrowing to the fields the column draws is deliberate.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ghIssues.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseDetail, parseSummaries } from '../../src/main/gh/issues'

const LIST = JSON.stringify([
  {
    number: 42,
    title: 'Fix the resizer',
    state: 'OPEN',
    stateReason: '',
    labels: [{ id: 'LA_x', name: 'bug', description: 'a bug', color: 'd73a4a' }],
    assignees: [{ id: 'U_x', login: 'paolo', name: 'Paolo' }],
    comments: [{}, {}, {}],
    updatedAt: '2026-08-09T10:00:00Z',
    author: { id: 'U_x', is_bot: false, login: 'paolo', name: 'Paolo' },
  },
  {
    number: 38,
    title: 'Rename the git column',
    state: 'CLOSED',
    stateReason: 'NOT_PLANNED',
    labels: [],
    assignees: [],
    comments: [],
    updatedAt: '2026-08-08T10:00:00Z',
    author: { login: 'someone' },
  },
])

describe('parseSummaries', () => {
  it('reads number, title, state and reason', () => {
    const rows = parseSummaries(LIST)
    expect(rows).toHaveLength(2)
    expect(rows[0].number).toBe(42)
    expect(rows[0].title).toBe('Fix the resizer')
    expect(rows[0].state).toBe('OPEN')
    expect(rows[1].stateReason).toBe('NOT_PLANNED')
  })

  it('reads the empty string gh sends for an open issue as no reason', () => {
    expect(parseSummaries(LIST)[0].stateReason).toBeNull()
  })

  it('keeps only the label fields the column draws', () => {
    expect(parseSummaries(LIST)[0].labels[0]).toEqual({ name: 'bug', color: 'd73a4a' })
  })

  it('collapses the comments array to a count', () => {
    expect(parseSummaries(LIST)[0].commentCount).toBe(3)
    expect(parseSummaries(LIST)[1].commentCount).toBe(0)
  })

  it('returns an empty list for an empty reply', () => {
    expect(parseSummaries('[]')).toEqual([])
  })

  it('returns an empty list rather than throwing on malformed JSON', () => {
    expect(parseSummaries('not json')).toEqual([])
  })

  it('drops an entry with no number rather than emitting NaN', () => {
    expect(parseSummaries('[{"title":"x"}]')).toEqual([])
  })
})

describe('parseDetail', () => {
  const DETAIL = JSON.stringify({
    number: 42,
    title: 'Fix the resizer',
    body: '## Steps\n\n1. Drag it',
    state: 'OPEN',
    stateReason: null,
    labels: [],
    assignees: [],
    comments: [{ author: { login: 'paolo' }, body: 'Still broken', createdAt: '2026-08-09T11:00:00Z' }],
    url: 'https://github.com/o/n/issues/42',
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-08-09T10:00:00Z',
    author: { login: 'paolo' },
  })

  it('keeps the body verbatim', () => {
    expect(parseDetail(DETAIL)?.body).toBe('## Steps\n\n1. Drag it')
  })

  it('keeps comments as a list, not a count', () => {
    const detail = parseDetail(DETAIL)
    expect(detail?.comments).toHaveLength(1)
    expect(detail?.comments[0].author.login).toBe('paolo')
    expect(detail?.commentCount).toBe(1)
  })

  it('returns null on malformed JSON', () => {
    expect(parseDetail('{')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ghIssues.test.ts`
Expected: FAIL, cannot resolve `../../src/main/gh/issues`.

- [ ] **Step 3: Add the shared types**

In `src/shared/ipc.ts`, add the six channel names to the `CHANNELS` object immediately after `columnsVisible`:

```ts
  issuesList: 'pterm:issuesList',
  issuesGet: 'pterm:issuesGet',
  issuesCreate: 'pterm:issuesCreate',
  issuesEdit: 'pterm:issuesEdit',
  issuesSetState: 'pterm:issuesSetState',
  issuesComment: 'pterm:issuesComment',
```

Add the type block from the Interfaces section above, placed after the `GitMutation` type. Add `IssuesFailure` as its own exported union there rather than importing it from `src/main`, because the renderer must not import from `src/main`:

```ts
export type IssuesFailure =
  | 'no-project'
  | 'no-repo'
  | 'no-remote'
  | 'not-github'
  | 'no-gh'
  | 'no-auth'
  | 'no-issues'
  | 'failed'
```

Then change `src/main/gh/run.ts` to import `IssuesFailure` from `../../shared/ipc` and re-export it, so there is exactly one definition.

**Do not touch `PTermApi` in this task.** Its only implementation is `src/preload/index.ts`, so adding a method to the interface and implementing it are one atomic change: split across two tasks, the tree cannot typecheck at the boundary, which contradicts the Global Constraint that every commit typechecks. Task 4 adds the two signatures, the preload implementations and the main handlers together. Adding `CHANNELS` entries and shared types with no consumer yet is harmless and belongs here.

- [ ] **Step 4: Write the read commands**

Create `src/main/gh/issues.ts`:

```ts
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

const LIMIT = 200

const LIST_FIELDS =
  'number,title,state,stateReason,labels,assignees,comments,updatedAt,author'
const DETAIL_FIELDS = `${LIST_FIELDS},body,url,createdAt`

function summary(row: Record<string, unknown>): IssueSummary | null {
  const number = row.number
  if (typeof number !== 'number') return null
  const comments = Array.isArray(row.comments) ? row.comments : []
  const labels = Array.isArray(row.labels) ? row.labels : []
  const assignees = Array.isArray(row.assignees) ? row.assignees : []
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
    const one = summary(entry as Record<string, unknown>)
    if (one) rows.push(one)
  }
  return rows
}

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
  const comments = Array.isArray(row.comments) ? row.comments : []
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
  'no-project': 'That project is not in this workspace.',
  'no-repo': 'This project is not inside a git repository.',
  'no-remote': 'This repository has no origin remote.',
  'not-github': 'The origin remote does not point at GitHub.',
  'no-gh': 'The GitHub CLI is not installed.',
  'no-auth': 'The GitHub CLI is not signed in.',
  'no-issues': 'Issues are disabled for this repository, or it cannot be read.',
  failed: 'The GitHub CLI reported an error.',
}

function failure<T>(reason: IssuesFailure, detail?: string): IssuesResult<T> {
  const trimmed = detail?.trim() ?? ''
  return {
    ok: false,
    reason,
    message: reason === 'failed' && trimmed !== '' ? trimmed : MESSAGES[reason],
  }
}

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

export async function getIssue(cwd: string, number: number): Promise<IssuesResult<IssueDetail>> {
  const resolved = await resolveRepo(cwd)
  if (!resolved.ok) return failure(resolved.reason)
  const arg = repoArg(resolved.ref)
  const run = await gh(cwd, [
    'issue',
    'view',
    String(number),
    '--repo',
    arg,
    '--json',
    DETAIL_FIELDS,
  ])
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/ghIssues.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
npm test
git add src/main/gh/issues.ts src/main/gh/run.ts src/shared/ipc.ts tests/unit/ghIssues.test.ts
git commit -m "Read GitHub issues through gh, with a typed failure for each way it can fail"
```

---

### Task 4: Wire the read path across IPC

**Files:**
- Modify: `src/main/ipc/register.ts` (add handlers beside the `gitChanges` handler, around line 1457)
- Modify: `src/preload/index.ts` (add to the `api` object beside `gitChanges`, around line 129)

**Interfaces:**
- Consumes: `listIssues`, `getIssue` from Task 3. `CHANNELS.issuesList`, `CHANNELS.issuesGet`, and the issue types from Task 3.
- Produces: the two `PTermApi` signatures, their preload implementations, and the main handlers, so that `window.pterm.issuesList(projectId, state)` and `window.pterm.issuesGet(projectId, number)` are callable from the renderer.

**This task owns the `PTermApi` addition**, which Task 3 deliberately does not make. `src/preload/index.ts` is the interface's only implementation, so the signature and the implementation have to land in one commit or the tree does not typecheck in between. Add both here:

```ts
  issuesList(projectId: string, state: IssueStateFilter): Promise<IssuesResult<IssueSummary[]>>
  issuesGet(projectId: string, number: number): Promise<IssuesResult<IssueDetail>>
```

Both handlers sit outside `serialise`, for the reason the existing `gitChanges` handler gives: they read a repository and never touch pTerm's config.

- [ ] **Step 1: Add the main handlers**

In `src/main/ipc/register.ts`, after the `gitChanges` handler:

```ts
  ipcMain.handle(
    CHANNELS.issuesList,
    async (_event, projectId: string, state: IssueStateFilter) => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) {
        return { ok: false as const, reason: 'no-project' as const, message: 'No project' }
      }
      return listIssues(project.cwd, state)
    },
  )

  ipcMain.handle(CHANNELS.issuesGet, async (_event, projectId: string, number: number) => {
    const config = await store.read()
    const project = config.projects.find((row) => row.id === projectId)
    if (!project) {
      return { ok: false as const, reason: 'no-project' as const, message: 'No project' }
    }
    return getIssue(project.cwd, number)
  })
```

Add the imports at the top of the file: `import { getIssue, listIssues } from '../gh/issues'` and `IssueStateFilter` to the existing type import from `../../shared/ipc`.

- [ ] **Step 2: Add the preload methods**

In `src/preload/index.ts`, beside `gitChanges`:

```ts
  issuesList: (projectId: string, state: IssueStateFilter) =>
    ipcRenderer.invoke(CHANNELS.issuesList, projectId, state),
  issuesGet: (projectId: string, number: number) =>
    ipcRenderer.invoke(CHANNELS.issuesGet, projectId, number),
```

Add `IssueStateFilter` to the type import list at the top of the file.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. If `PTermApi` and the `api` object disagree, TypeScript names the missing method here; that is the check this step exists for.

- [ ] **Step 4: Run the full unit suite**

Run: `npm test`
Expected: PASS. `tests/unit/ipc.test.ts` exists and asserts on the channel surface; if it enumerates channels, add the six new ones there.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/register.ts src/preload/index.ts tests/unit/ipc.test.ts
git commit -m "Expose the issues read path on the preload bridge"
```

---

### Task 5: Register the column

This task adds an eighth column that renders a placeholder. It is its own task because the registration touches nine files and is worth reviewing on its own, separately from anything the column draws.

**Files:**
- Create: `src/renderer/IssuesPanel.tsx`
- Modify: `src/shared/ipc.ts:1167` (`ColumnId`), and the `MenuCommand` union at line 98
- Modify: `src/renderer/lib/columnVisibility.ts` (`COLUMN_IDS`)
- Modify: `src/renderer/lib/columnOrder.ts` (`COLUMN_ORDER_DEFAULT`)
- Modify: `src/renderer/App.tsx` (collapsed key, `HIDDEN_KEYS`, state, toggle, `collapsedColumns`, the `Alt+Cmd` letter map, the menu command switch, the slot switch)
- Modify: `src/main/index.ts` (the `View` menu item, the `showColumns` id map)
- Modify: `tests/unit/columnVisibility.test.ts`, `tests/unit/columnOrder.test.ts`
- Create: `tests/e2e/issuesColumn.spec.ts`

**Interfaces:**
- Consumes: `ProjectDescriptor` from `src/shared/ipc`, `useColumnWidth` from `src/renderer/lib/columnWidth`, `ColumnResizer`/`PanelHeading`/`PanelStrip`/`PanelSide` from `src/renderer/ui/Panel`.
- Produces: `export function IssuesPanel(props: { project: ProjectDescriptor | undefined; collapsed: boolean; onToggle: () => void; onDragStart: () => void; side: PanelSide }): JSX.Element`, and the testids `issues-toggle` (both strip and heading, matching `NotesPanel`) and `issues-panel`.

- [ ] **Step 1: Write the failing unit tests**

In `tests/unit/columnVisibility.test.ts` and `tests/unit/columnOrder.test.ts`, extend whatever assertions enumerate the column set so they include `issues`. Read each file first; the existing tests already encode the count and the default order, and both will fail until the constants change.

Add to `tests/unit/columnOrder.test.ts`:

```ts
it('places issues next to git in the default order', () => {
  const git = COLUMN_ORDER_DEFAULT.indexOf('git')
  const issues = COLUMN_ORDER_DEFAULT.indexOf('issues')
  expect(issues).toBeGreaterThan(-1)
  expect(Math.abs(issues - git)).toBe(1)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/columnOrder.test.ts tests/unit/columnVisibility.test.ts`
Expected: FAIL, `issues` is not in the union and not in the default order.

- [ ] **Step 3: Widen the types and the constants**

`src/shared/ipc.ts:1167`:

```ts
export type ColumnId = 'tabs' | 'files' | 'skills' | 'presets' | 'prompts' | 'notes' | 'git' | 'issues'
```

Add `| 'toggleIssues'` to the `MenuCommand` union at line 98.

`src/renderer/lib/columnVisibility.ts`, add `'issues'` to `COLUMN_IDS` after `'git'`.

`src/renderer/lib/columnOrder.ts`, add `'issues'` to `COLUMN_ORDER_DEFAULT` immediately after `'git'`.

`npm run typecheck` now fails in several files because `Record<ColumnId, ...>` maps are missing a key. That is the intended guide: fix each one it names.

- [ ] **Step 4: Write the placeholder column**

Create `src/renderer/IssuesPanel.tsx`, modelled on `src/renderer/NotesPanel.tsx`:

```tsx
import type { ProjectDescriptor } from '../shared/ipc'
import { useColumnWidth } from './lib/columnWidth'
import { cn } from './lib/cn'
import { ColumnResizer, PanelHeading, PanelStrip, type PanelSide } from './ui/Panel'

export function IssuesPanel({
  project,
  collapsed,
  onToggle,
  onDragStart,
  side,
}: {
  project: ProjectDescriptor | undefined
  collapsed: boolean
  onToggle: () => void
  onDragStart: () => void
  side: PanelSide
}) {
  const { width, set, commit } = useColumnWidth('pterm:issuesWidth', 256)

  if (collapsed) {
    return (
      <PanelStrip
        testid="issues-toggle"
        label="Issues"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
      />
    )
  }

  return (
    <div
      data-testid="issues-panel"
      className={cn(
        'relative flex shrink-0 flex-col border-border bg-surface font-mono text-[11px] select-none',
        side === 'left' ? 'border-r' : 'border-l',
      )}
      style={{ width }}
    >
      <PanelHeading
        testid="issues-toggle"
        label="Issues"
        onClick={onToggle}
        onDragStart={onDragStart}
      />
      <div data-testid="issues-body" className="px-2.5 py-2 text-label">
        {project ? project.name : 'No project'}
      </div>
      <ColumnResizer
        testid="issues-resizer"
        side={side}
        width={width}
        onResize={set}
        onCommit={commit}
      />
    </div>
  )
}
```

Read `NotesPanel.tsx` before writing this and match whatever its `ColumnResizer` call looks like at that moment, including any clamping the caller applies to `onResize`.

- [ ] **Step 5: Wire it into App.tsx**

In `src/renderer/App.tsx`, mirroring every place `git` appears:

```ts
const ISSUES_KEY = 'pterm:issuesCollapsed'
```

Add `issues: 'pterm:issuesHidden'` to `HIDDEN_KEYS`. Add `const [issuesCollapsed, setIssuesCollapsed] = useState(() => storedCollapsed(ISSUES_KEY, true))`. Add `issues: storedCollapsed(HIDDEN_KEYS.issues, true)` to the `hiddenColumns` initialiser. Add `issues: issuesCollapsed` to `collapsedColumns`.

Add the toggle beside `toggleGit`:

```ts
  const toggleIssues = useCallback(() => {
    setColumnHidden('issues', !hiddenColumns.issues)
  }, [hiddenColumns.issues, setColumnHidden])
```

Add `KeyI: toggleIssues` to the `Alt+Cmd` letter map, add `case 'toggleIssues': toggleIssues(); break` to the menu command switch, add `toggleIssues` to both dependency arrays that list `toggleGit`, and add the slot case:

```tsx
      case 'issues':
        return hiddenColumns.issues ? null : (
          <IssuesPanel
            project={project}
            collapsed={issuesCollapsed}
            onToggle={() => toggleColumnCollapsed('issues')}
            onDragStart={() => setDragging('issues')}
            side={resizerSideFor(columnOrder, 'issues')}
          />
        )
```

`toggleColumnCollapsed` is an existing helper; read how it maps a `ColumnId` to its setter and add `issues` there too.

- [ ] **Step 6: Wire the menu**

In `src/main/index.ts`, add to the `View` template after `toggle-git`:

```ts
        {
          id: 'toggle-issues',
          label: 'Issues',
          type: 'checkbox',
          accelerator: 'Alt+CmdOrCtrl+I',
          registerAccelerator: false,
          click: () => sendMenuCommand('toggleIssues'),
        },
```

Add `issues: 'toggle-issues'` to the `ids` map inside `showColumns`.

`registerAccelerator: false` matters and is not decorative: this app's accelerators are matched in the renderer, and a menu that registers them itself would swallow the key before the renderer sees it.

- [ ] **Step 7: Write the e2e spec**

Create `tests/e2e/issuesColumn.spec.ts`. Read `tests/e2e/columns.spec.ts` and `tests/e2e/harness.ts` first and follow their setup exactly. Assert:

```ts
test('the issues column is hidden on a fresh profile and the View menu shows it', async () => {
  await expect(page.getByTestId('issues-toggle')).toHaveCount(0)
  await clickMenuItem(app, 'toggle-issues')
  await expect(page.getByTestId('issues-toggle')).toHaveCount(1)
})

test('the heading collapses it to a strip and the strip brings it back', async () => {
  await clickMenuItem(app, 'toggle-issues')
  await page.getByTestId('issues-toggle').click()
  await expect(page.getByTestId('issues-panel')).toHaveCount(0)
  await page.getByTestId('issues-toggle').click()
  await expect(page.getByTestId('issues-panel')).toHaveCount(1)
})
```

`clickMenuItem` is whatever `tests/e2e/menuColumns.spec.ts` already uses; reuse it rather than writing a second one.

- [ ] **Step 8: Fix the columns the new one broke**

Run: `npx playwright test tests/e2e/splits.spec.ts tests/e2e/columns.spec.ts tests/e2e/menuColumns.spec.ts tests/e2e/columnOrder.spec.ts`

Expect failures in the specs that enumerate the row. **Measured when this task ran: only `columnOrder.spec.ts` failed, in three order-array literals, and no pixel constant needed changing.** `splits.spec.ts`, `columns.spec.ts` and `menuColumns.spec.ts` were untouched, because the column is hidden and collapsed by default and none of those specs open it, so it occupies no width they measure. The full unfiltered run stayed at 211 passing.

Treat the prediction as the thing to check, not as the thing to make true: if `splits.spec.ts` does fail, something has made the column take width by default, and that is the bug rather than the constants.

Do not "fix" a failure by loosening an assertion into one that cannot fail. If a pixel constant has to change, change it to the new measured value, not to a range.

- [ ] **Step 9: Run everything and commit**

```bash
npm run typecheck
npm test
npx playwright test
git add -A
git commit -m "Add the issues column, hidden by default, drawing a placeholder"
```

---

### Task 6: The list

**Files:**
- Create: `src/renderer/lib/issueList.ts`
- Create: `tests/unit/issueList.test.ts`
- Modify: `src/renderer/IssuesPanel.tsx`
- Create: `tests/e2e/fixtures/gh-stub.mjs`
- Create: `tests/e2e/issuesList.spec.ts`
- Modify: `tests/e2e/harness.ts` (accept an optional `ghBin` and pass it as `PTERM_GH_BIN`)

**Interfaces:**
- Consumes: `IssueSummary`, `IssueStateFilter`, `IssuesResult`, `IssuesFailure` from `src/shared/ipc`. `window.pterm.issuesList` from Task 4.
- Produces: `export type IssueSort = 'updated' | 'newest' | 'comments'`, `export function filterIssues(rows: IssueSummary[], query: string): IssueSummary[]`, `export function sortIssues(rows: IssueSummary[], sort: IssueSort): IssueSummary[]`.

The filter and sort live in their own module because `vitest.config.mts` runs `environment: 'node'`, so logic inside a component cannot be unit-tested in this repo at all.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/issueList.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { IssueSummary } from '../../src/shared/ipc'
import { filterIssues, sortIssues } from '../../src/renderer/lib/issueList'

function issue(over: Partial<IssueSummary>): IssueSummary {
  return {
    number: 1,
    title: 'A title',
    state: 'OPEN',
    stateReason: null,
    labels: [],
    assignees: [],
    commentCount: 0,
    updatedAt: '2026-08-01T00:00:00Z',
    author: { login: 'paolo' },
    ...over,
  }
}

describe('filterIssues', () => {
  const rows = [
    issue({ number: 42, title: 'Fix the resizer', labels: [{ name: 'bug', color: 'aaa' }] }),
    issue({ number: 7, title: 'Add a column' }),
  ]

  it('returns everything for an empty query', () => {
    expect(filterIssues(rows, '')).toHaveLength(2)
  })

  it('matches the title case-insensitively', () => {
    expect(filterIssues(rows, 'RESIZER').map((row) => row.number)).toEqual([42])
  })

  it('matches the number', () => {
    expect(filterIssues(rows, '7').map((row) => row.number)).toEqual([7])
  })

  it('matches the number with a leading hash', () => {
    expect(filterIssues(rows, '#42').map((row) => row.number)).toEqual([42])
  })

  it('matches a label name', () => {
    expect(filterIssues(rows, 'bug').map((row) => row.number)).toEqual([42])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterIssues(rows, 'zzzz')).toEqual([])
  })

  it('ignores surrounding whitespace', () => {
    expect(filterIssues(rows, '  resizer  ').map((row) => row.number)).toEqual([42])
  })
})

describe('sortIssues', () => {
  const rows = [
    issue({ number: 1, updatedAt: '2026-08-01T00:00:00Z', commentCount: 5 }),
    issue({ number: 9, updatedAt: '2026-08-09T00:00:00Z', commentCount: 0 }),
    issue({ number: 5, updatedAt: '2026-08-05T00:00:00Z', commentCount: 2 }),
  ]

  it('sorts by most recently updated', () => {
    expect(sortIssues(rows, 'updated').map((row) => row.number)).toEqual([9, 5, 1])
  })

  it('sorts by newest number', () => {
    expect(sortIssues(rows, 'newest').map((row) => row.number)).toEqual([9, 5, 1])
  })

  it('sorts by comment count', () => {
    expect(sortIssues(rows, 'comments').map((row) => row.number)).toEqual([1, 5, 9])
  })

  it('does not mutate its input', () => {
    const before = rows.map((row) => row.number)
    sortIssues(rows, 'comments')
    expect(rows.map((row) => row.number)).toEqual(before)
  })
})
```

The `newest` and `updated` cases agree on this fixture by construction. That is deliberate: build a second fixture where an old issue was updated recently, and assert the two orders differ, so neither implementation can satisfy both tests by accident:

```ts
it('separates newest from recently updated', () => {
  const mixed = [
    issue({ number: 100, updatedAt: '2026-01-01T00:00:00Z', commentCount: 0 }),
    issue({ number: 2, updatedAt: '2026-08-09T00:00:00Z', commentCount: 0 }),
  ]
  expect(sortIssues(mixed, 'newest').map((row) => row.number)).toEqual([100, 2])
  expect(sortIssues(mixed, 'updated').map((row) => row.number)).toEqual([2, 100])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/issueList.test.ts`
Expected: FAIL, cannot resolve `issueList`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/lib/issueList.ts`:

```ts
import type { IssueSummary } from '../../shared/ipc'

export type IssueSort = 'updated' | 'newest' | 'comments'

export function filterIssues(rows: IssueSummary[], query: string): IssueSummary[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  const bare = needle.startsWith('#') ? needle.slice(1) : needle
  return rows.filter((row) => {
    if (row.title.toLowerCase().includes(needle)) return true
    if (String(row.number).includes(bare)) return true
    return row.labels.some((label) => label.name.toLowerCase().includes(needle))
  })
}

export function sortIssues(rows: IssueSummary[], sort: IssueSort): IssueSummary[] {
  const copy = [...rows]
  if (sort === 'newest') return copy.sort((a, b) => b.number - a.number)
  if (sort === 'comments') return copy.sort((a, b) => b.commentCount - a.commentCount)
  return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/issueList.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Build the list UI**

Rewrite the body of `src/renderer/IssuesPanel.tsx`. It holds:

- `rows: IssueSummary[] | null`, `repo: IssueRepo | null`, `truncated: boolean`, `failure: { reason: IssuesFailure; message: string } | null`, `loading: boolean`, `query: string`, `state: IssueStateFilter` (default `'open'`), `sort: IssueSort` (default `'updated'`).
- A `load` callback calling `window.pterm.issuesList(project.id, state)`, guarded by a cancellation flag the way `NotesPanel`'s fetch is, and keyed on `project?.id` and `state`.
- Refetch on mount while expanded, on project change, on state change, on a window `focus` listener throttled to once per 60 seconds, and from the refresh button. No `setInterval`.
- The previous rows stay on screen while `loading` is true, so a refetch does not blank the list.

Chrome, in order: the heading; a line showing `repo.slug` and either `${rows.length} open` or `200+` when `truncated`; a search input (`data-testid="issues-search"`); a row holding three state buttons (`issues-state-open`, `issues-state-closed`, `issues-state-all`) and a sort button (`issues-sort`); then the list (`issues-list`).

Each row is a button with `data-testid={`issue-row-${row.number}`}` carrying `#number`, the title, and a second line with the relative time, comment count and label dots. Use the existing `src/renderer/lib/elapsed.ts` or `historyAgo.ts` for the relative time rather than writing a third one; read both and pick the one whose output shape fits.

When `failure` is set, the body renders the message instead of the list, with `data-testid={`issues-empty-${failure.reason}`}`. For `no-gh` and `no-auth`, also render a selectable `<code>` element containing `brew install gh` and `gh auth login` respectively.

None of these testids may begin with `tab-`.

- [ ] **Step 6: Write the gh stub**

Create `tests/e2e/fixtures/gh-stub.mjs`, an executable Node script:

```js
#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const log = process.env.PTERM_GH_STUB_LOG
if (log) appendFileSync(log, JSON.stringify(args) + '\n')

const mode = process.env.PTERM_GH_STUB_MODE ?? 'ok'
if (mode === 'no-auth') {
  process.stderr.write('To get started with GitHub CLI, please run: gh auth login\n')
  process.exit(4)
}
if (mode === 'no-issues') {
  process.stderr.write('GraphQL: Could not resolve to a Repository with the name o/n.\n')
  process.exit(1)
}

const fixture = process.env.PTERM_GH_STUB_FIXTURE
if (fixture) {
  process.stdout.write(readFileSync(fixture, 'utf8'))
} else {
  process.stdout.write('[]')
}
process.exit(0)
```

Mark it executable (`chmod +x`). The spec writes its fixture JSON to a temp file and points `PTERM_GH_STUB_FIXTURE` at it.

- [ ] **Step 7: Thread `PTERM_GH_BIN` through the harness**

In `tests/e2e/harness.ts`, add an optional `ghBin?: string` to `launchApp`'s options and, in the `env` block beside the other `PTERM_*` entries:

```ts
      ...(opts.ghBin !== undefined ? { PTERM_GH_BIN: opts.ghBin } : {}),
```

Also pass through `PTERM_GH_STUB_MODE`, `PTERM_GH_STUB_FIXTURE` and `PTERM_GH_STUB_LOG` when given, since the stub reads them from its own environment and it inherits this one.

- [ ] **Step 8: Write the list e2e spec**

Create `tests/e2e/issuesList.spec.ts`. Set up a project whose cwd is a real git repo with an `origin` pointing at `https://github.com/o/n.git` (`git init`, `git remote add origin ...`, the way `gitpanel.spec.ts` builds its repo). Launch with `ghBin` set to the stub. Assert:

- Two fixture issues appear as `issue-row-42` and `issue-row-38`.
- Typing `resizer` into `issues-search` leaves one row.
- Clearing the search restores both.
- The recorded argv log contains `--repo` and `o/n` on the list call.
- With `PTERM_GH_STUB_MODE=no-auth`, `issues-empty-no-auth` is visible and the list is not.
- With a fixture of exactly 200 entries, the heading shows `200+`.

Each of these is its own `test()`. Do not share a search query across tests: a filter typed in one test is still typed in the next, because a spec file shares one `page`, and a later count assertion would be measuring the earlier query.

- [ ] **Step 9: Run and commit**

```bash
npm run typecheck
npm test
npx playwright test tests/e2e/issuesList.spec.ts tests/e2e/issuesColumn.spec.ts
git add -A
git commit -m "Draw the issues list, with search, filter, sort and a message for each failure"
```

---

### Task 7: The detail modal, read-only

**Files:**
- Create: `src/renderer/IssueModal.tsx`
- Create: `src/renderer/ui/MarkdownView.tsx`
- Modify: `src/renderer/IssuesPanel.tsx` (open the modal from a row click)
- Create: `tests/e2e/issueModal.spec.ts`

**Interfaces:**
- Consumes: `IssueDetail`, `IssuesResult` from `src/shared/ipc`. `window.pterm.issuesGet` from Task 4. `Dialog`, `DialogContent`, `DialogTitle` from `src/renderer/ui/Dialog`.
- Produces: `export function IssueModal(props: { projectId: string; number: number | null; onClose: () => void }): JSX.Element | null` and `export function MarkdownView(props: { value: string; className?: string }): JSX.Element`.

- [ ] **Step 1: Build the markdown view**

Create `src/renderer/ui/MarkdownView.tsx`: a read-only CodeMirror 6 editor with `markdown()` from `@codemirror/lang-markdown` and the repo's existing highlight setup.

Read `src/renderer/FileView.tsx` first. It already builds a read-only CodeMirror with syntax highlighting, and this component should be the same construction with the language fixed to markdown and the height driven by content rather than by a pane. Reuse `src/renderer/lib/syntaxColors.ts` rather than defining a second theme.

**This renders markdown SOURCE. It must never render or inject HTML.** An issue body is text an arbitrary GitHub user wrote, and this is an Electron renderer. If a future task wants rendered markdown, that is its own decision with its own sanitizer review.

- [ ] **Step 2: Build the modal**

Create `src/renderer/IssueModal.tsx`, following `src/renderer/settings/SettingsPane.tsx` for the Dialog construction:

```tsx
<Dialog open={number !== null} onOpenChange={(next) => { if (!next) onClose() }}>
  <DialogContent
    data-testid="issue-modal"
    className="scroll-thin max-h-[85vh] w-[720px] max-w-[90vw] overflow-y-auto"
  >
    ...
  </DialogContent>
</Dialog>
```

Contents: `DialogTitle` holding `#42` and the title; a state chip (`data-testid="issue-state"`) reading `Open`, `Closed as completed`, or `Closed as not planned` from `state` and `stateReason`; the author and created-at; a link button opening `detail.url` externally; label and assignee chips; `MarkdownView` for the body; then each comment as author, relative time and a `MarkdownView`.

While the fetch is in flight, render a `data-testid="issue-loading"` placeholder. On a failed fetch, render the message with `data-testid="issue-error"`.

The link must open in the user's browser, not in the Electron window. Check how the app already opens external URLs (grep for `shell.openExternal`); if there is no existing path, add one rather than using a bare `<a href>` inside the renderer.

- [ ] **Step 3: Open it from a row**

In `IssuesPanel.tsx`, hold `const [open, setOpen] = useState<number | null>(null)`, set it from a row click, and render `<IssueModal projectId={project.id} number={open} onClose={() => setOpen(null)} />`.

- [ ] **Step 4: Write the e2e spec**

Create `tests/e2e/issueModal.spec.ts`, using the same stub and repo setup as Task 6. Assert:

- Clicking `issue-row-42` shows `issue-modal`.
- The modal contains the fixture's body text.
- `issue-state` reads `Closed as not planned` for the fixture issue whose `stateReason` is `NOT_PLANNED`.
- `Escape` closes it.
- The recorded argv shows `issue view 42 --repo o/n`.

For the body-text assertion, assert on text the fixture body contains and nothing else on screen contains, so the assertion cannot pass by matching the row title behind the modal.

- [ ] **Step 5: Run and commit**

```bash
npm run typecheck
npm test
npx playwright test tests/e2e/issueModal.spec.ts
git add -A
git commit -m "Open an issue in a modal, rendering its body as markdown source"
```

---

### Task 8: Mutations

**Files:**
- Modify: `src/main/gh/issues.ts` (create, edit, setState, comment)
- Modify: `src/shared/ipc.ts` (`PTermApi` methods)
- Modify: `src/main/ipc/register.ts`, `src/preload/index.ts`
- Modify: `src/renderer/IssueModal.tsx` (edit mode, create mode, comment box, close/reopen)
- Modify: `src/renderer/IssuesPanel.tsx` (the `+` button, the hover quick-close)
- Create: `tests/unit/ghMutations.test.ts`
- Create: `tests/e2e/issueMutations.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 3, 4, 6 and 7.
- Produces, in `src/main/gh/issues.ts`:

```ts
export function issueArgs(
  action: 'close' | 'reopen',
  number: number,
  arg: string,
  reason?: 'completed' | 'not planned',
): string[]

export function createIssue(cwd: string, title: string, body: string): Promise<IssuesResult<number>>
export function editIssue(cwd: string, number: number, title: string, body: string): Promise<IssuesResult<true>>
export function setIssueState(cwd: string, number: number, action: 'close' | 'reopen', reason?: 'completed' | 'not planned'): Promise<IssuesResult<true>>
export function commentIssue(cwd: string, number: number, body: string): Promise<IssuesResult<true>>
```

  and on `PTermApi`: `issuesCreate(projectId, title, body)`, `issuesEdit(projectId, number, title, body)`, `issuesSetState(projectId, number, action, reason?)`, `issuesComment(projectId, number, body)`.

`issueArgs` is split out as a pure function purely so the argv can be asserted without spawning anything. It is the piece most likely to be got subtly wrong.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ghMutations.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { issueArgs } from '../../src/main/gh/issues'

describe('issueArgs', () => {
  it('closes with a completed reason', () => {
    expect(issueArgs('close', 42, 'o/n', 'completed')).toEqual([
      'issue', 'close', '42', '--repo', 'o/n', '--reason', 'completed',
    ])
  })

  it('passes "not planned" as one unquoted argv element', () => {
    const args = issueArgs('close', 42, 'o/n', 'not planned')
    expect(args).toContain('not planned')
    expect(args.some((arg) => arg.includes('"') || arg.includes("'"))).toBe(false)
  })

  it('omits the reason when reopening', () => {
    expect(issueArgs('reopen', 42, 'o/n')).toEqual(['issue', 'reopen', '42', '--repo', 'o/n'])
  })

  it('never omits --repo', () => {
    expect(issueArgs('close', 1, 'gh.corp/o/n')).toContain('--repo')
    expect(issueArgs('reopen', 1, 'gh.corp/o/n')).toContain('gh.corp/o/n')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ghMutations.test.ts`
Expected: FAIL, `issueArgs` is not exported.

- [ ] **Step 3: Write the mutation commands**

Add to `src/main/gh/issues.ts`:

```ts
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

async function mutate<T>(
  cwd: string,
  build: (arg: string) => { args: string[]; stdin?: string },
  read: (run: { stdout: string }) => T,
): Promise<IssuesResult<T>> {
  const resolved = await resolveRepo(cwd)
  if (!resolved.ok) return failure(resolved.reason)
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

export function setIssueState(
  cwd: string,
  number: number,
  action: 'close' | 'reopen',
  reason?: 'completed' | 'not planned',
): Promise<IssuesResult<true>> {
  return mutate(cwd, (arg) => ({ args: issueArgs(action, number, arg, reason) }), () => true)
}

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

export function createIssue(cwd: string, title: string, body: string): Promise<IssuesResult<number>> {
  return mutate(
    cwd,
    (arg) => ({
      args: ['issue', 'create', '--repo', arg, '--title', title, '--body-file', '-'],
      stdin: body,
    }),
    (run) => {
      const match = /\/issues\/(\d+)\s*$/.exec(run.stdout.trim())
      return match ? Number(match[1]) : 0
    },
  )
}
```

`gh issue create` prints the new issue's URL on stdout rather than JSON, which is why `createIssue` reads a number out of it. A `0` means the issue was created but the number could not be read; the caller refetches the list either way, so this is a display detail and not a failure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ghMutations.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire the four channels**

Add the handlers to `src/main/ipc/register.ts` and the methods to `src/preload/index.ts` and `PTermApi`, following exactly the shape Task 4 established. Run `npm run typecheck` after; it names anything missed.

- [ ] **Step 6: Build the write UI**

In `IssueModal.tsx`:

- A `mode` of `'read' | 'edit' | 'create'`. `create` is entered by the panel's `+` with `number === null`.
- Edit and create render a title `<input data-testid="issue-title-input">` and a writable CodeMirror for the body.
- A comment box (`issue-comment-input`) with a submit button (`issue-comment-submit`).
- A footer: `issue-close-completed`, `issue-close-not-planned`, `issue-reopen`, `issue-edit`, `issue-save`, `issue-cancel`, `issue-create-submit`, each rendered only in the states where it applies.
- Every submit disables its button and shows a spinner while in flight. **No optimistic update.** On success, refetch the detail and tell the panel to refetch the list. On failure, render `gh`'s message in an inline strip (`issue-error`) that stays until the next attempt.
- `⌘Enter` submits whichever of create, edit or comment is active. Bind it on the modal, not globally.
- `Escape` closes, but when the title or body is dirty it routes through a discard confirm first. Read `src/renderer/ConfirmClosePane.tsx` and `src/renderer/lib/mutationGuard.ts` and reuse whichever of those two the codebase already uses for this shape; do not add a third confirm component.

In `IssuesPanel.tsx`: the heading `+` opens the modal in create mode, and each open row gets a hover button `issue-quick-close-${number}` calling `issuesSetState(id, number, 'close', 'completed')` then refetching.

- [ ] **Step 7: Write the e2e spec**

Create `tests/e2e/issueMutations.spec.ts`, using the stub. Because the stub does not maintain state, these tests assert on the **recorded argv**, which is the contract that matters:

- Clicking `issue-close-completed` records `issue close 42 --repo o/n --reason completed`.
- Clicking `issue-close-not-planned` records an argv whose `--reason` value is exactly `not planned`, with no quote characters in any element.
- `issue-reopen` records no `--reason`.
- Submitting a comment records `issue comment 42 --repo o/n --body-file -`.
- With `PTERM_GH_STUB_MODE=no-auth`, a close attempt leaves `issue-error` visible.

Assert the argv by reading `PTERM_GH_STUB_LOG` from the test, not by scraping the UI.

- [ ] **Step 8: Run and commit**

```bash
npm run typecheck
npm test
npx playwright test tests/e2e/issueMutations.spec.ts
git add -A
git commit -m "Create, edit, comment on and close issues from the modal"
```

---

### Task 9: Rename the Git column to "Git Changes" and give it an empty state

**Files:**
- Modify: `src/renderer/GitPanel.tsx:304,329` (the `PanelStrip` and `PanelHeading` labels)
- Modify: `src/main/index.ts` (the `toggle-git` menu item label)
- Modify: whichever e2e specs assert on the string `Git`
- Create or modify: `tests/e2e/gitpanel.spec.ts` (the no-repo case)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. This is a label change plus an empty state. `ColumnId` stays `'git'`, the testids stay `git-toggle` and `git-panel`, the accelerator stays `Alt+CmdOrCtrl+G`, and the storage keys stay `pterm:gitWidth` / `pterm:gitCollapsed` / `pterm:gitHidden`. Changing any of those would silently reset every existing user's column.

- [ ] **Step 1: Find what asserts on the label**

Run: `grep -rn "'Git'\|\"Git\"\|>Git<\|getByText('Git')" src tests`

Every hit is either a thing to change or a test that will fail. List them before editing.

- [ ] **Step 2: Change the labels**

`src/renderer/GitPanel.tsx`, both the `PanelStrip` `label="Git"` at line 304 and the `PanelHeading` `label="Git"` at line 329, become `label="Git Changes"`.

`src/main/index.ts`, the `toggle-git` item's `label: 'Git'` becomes `label: 'Git Changes'`.

Note that `PanelStrip` renders its label in `writingMode: 'vertical-rl'`, so "Git Changes" now runs down the strip at more than double the length. Launch the app and look at it before committing. If it overflows a short window, the fix is a shorter label, not a clipped one; raise it rather than shipping something cut off.

- [ ] **Step 3: Add the no-repo empty state**

In `GitPanel.tsx`, when the project's `gitChanges` call returns null, render a message with `data-testid="git-empty-no-repo"` reading that the project is not inside a git repository, instead of an empty file list. Read the component's current null handling first; it may already have a branch to extend rather than a new one to add.

- [ ] **Step 4: Update the failing specs**

Run: `npx playwright test tests/e2e/gitpanel.spec.ts tests/e2e/menuColumns.spec.ts tests/e2e/columns.spec.ts`

Fix each assertion that named the old label. Add a test that a project pointed at a non-repository directory shows `git-empty-no-repo`.

- [ ] **Step 5: Run and commit**

```bash
npm run typecheck
npm test
npx playwright test
git add -A
git commit -m "Rename the Git column to Git Changes and say so when there is no repository"
```

---

### Task 10: Full-suite pass and a look at the running app

**Files:** none created. This task exists because the previous nine were each verified in isolation.

- [ ] **Step 1: Run the whole suite**

```bash
npm run typecheck
npm test
npx playwright test
```

All three must be clean. A flake is not a pass: if a spec fails once and passes on a rerun, run it five more times and say so in the report rather than moving on.

- [ ] **Step 2: Open the app and use the feature**

Run `npm start`. With a project pointed at a real GitHub repository:

- Show the Issues column from the View menu and with `⌥⌘I`.
- Confirm it was hidden before that, on a profile that had never seen it.
- Drag its resizer; drag the column itself to another position in the row.
- Search, switch state filters, switch sorts.
- Open an issue, read the body, close the modal with `Escape`.
- Create an issue, comment on it, edit it, close it as completed, reopen it, close it as not planned. Check each one on github.com.
- Point a project at a directory that is not a repository and confirm both the Issues and Git Changes columns say so.

Automated gates cannot see the shipped artifact. This step is the only one that looks at it.

- [ ] **Step 3: Report**

Report what was verified by running it, what was verified only by tests, and anything left undone. Do not report the feature as complete on the strength of a green suite alone.

---

## Self-Review

Run against `docs/superpowers/specs/2026-08-09-issues-panel-design.md`.

**Spec coverage.** Transport and env vars: Task 2. `--repo` always: Tasks 1, 3, 8, asserted in Tasks 6, 7, 8. Column, width key, collapsed-by-default, drag: Task 5. Heading, search, filter, sort, rows, hover buttons, truncation marker: Task 6. Seven typed failures and their messages: Tasks 2, 3, 6. Freshness rules, no interval poll: Task 6. Client-side search: Task 6. Modal, three-state chip, markdown source, comments: Task 7. Create, edit, comment, close with reason, reopen, pessimistic mutations, inline error: Task 8. `⌘Enter`, `Escape` with discard confirm, `⌥⌘I`: Tasks 5, 8. Git rename and its empty state: Task 9. Blast radius on `splits.spec.ts`, `columns.spec.ts`, `menuColumns.spec.ts`: Task 5 step 8. Delete stays cut: no task implements it.

**Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Three steps deliberately say "read the existing file first and match it" (Task 5 step 4, Task 7 step 1, Task 8 step 6). Those are not placeholders: they point at a named file whose current shape is the specification, and inlining a stale copy of it here is exactly the failure mode the Global Constraints warn about.

**Type consistency.** `IssuesFailure` is defined once in `src/shared/ipc.ts` and re-exported from `src/main/gh/run.ts` (Task 3 step 3), so Tasks 2, 3 and 6 name the same union. `IssueRepo` carries `slug` and `arg` everywhere it appears. `repoArg` returns the `arg` field, never the `slug`. `issueArgs` takes `arg`, matching `mutate`. `filterIssues`/`sortIssues` keep the names used in Task 6 step 5. Testids: `issues-*` for the column, `issue-*` for the modal and rows, and none begin with `tab-`.
