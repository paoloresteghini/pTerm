# Terminal History Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing Up in a `shell` pane opens a list of past commands scoped to the current project, and Enter types the chosen one onto the prompt without running it.

**Architecture:** A zsh `preexec` hook appends one JSON line per command to `~/.prcli/history.jsonl`. Main reads and filters it through a pure function. The renderer draws an overlay anchored to the bottom of the pane, opened by a single intercepted keystroke in xterm.

**Tech Stack:** TypeScript, Electron, React, xterm.js, node-pty, tmux, vitest, Playwright. No new dependencies.

Spec: `docs/superpowers/specs/2026-08-06-terminal-history-overlay-design.md`

## Global Constraints

- **No em dashes anywhere.** Not in code, comments, copy, or commit messages. Use commas, colons, parentheses, or separate sentences. Hyphens in compound words are fine.
- **macOS and zsh only.** This repo ships no Windows or Linux maker and no bash/fish support.
- **No new npm dependencies.** Everything here is built from what is already installed.
- **Every config path must have a test seam.** `configRoot()` already honours `PRCLI_CONFIG_DIR`. The new zshrc path must honour `PRCLI_ZSHRC` for the same reason: without it the test suite edits the developer's real `~/.zshrc`. The suite already pollutes the real `~/.zsh_history`; do not add a second instance of that bug.
- **Write your own comments.** Do NOT transcribe comment text out of this plan into the code. Where this plan explains why something is done, re-derive it and write it in your own words, and verify any factual claim a comment makes before you write it. A comment that is false is worse than no comment.
- **A test that has not been seen to fail has not been shown to test anything.** Every task's test step includes running it against unmodified code and confirming the failure message, and the final task A/B's the suite by sabotage.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/main/shell/history.ts` (create) | history file path, parse JSONL, and the pure scope/filter/dedupe function |
| `src/main/shell/install.ts` (create) | render the zsh snippet, edit `~/.zshrc` between markers, report state, uninstall |
| `src/shared/ipc.ts` (modify) | four new channels, the `HistoryEntry`/`HistoryScope`/`ShellHistoryState` types, four new `PrcliApi` members |
| `src/preload/index.ts` (modify) | bridge the four channels |
| `src/main/ipc/register.ts` (modify) | four new handlers |
| `src/renderer/SettingsPane.tsx` (modify) | a Shell history row beside the existing hooks row |
| `src/renderer/HistoryOverlay.tsx` (create) | the list, its own key handling, anchored to the pane |
| `src/renderer/Terminal.tsx` (modify) | one `attachCustomKeyEventHandler` for the opening Up |
| `src/renderer/App.tsx` (modify) | own which pane's overlay is open, and type the chosen command |
| `tests/e2e/harness.ts` (modify) | a `capturePane` helper, which does not exist yet |
| `tests/unit/shellHistory.test.ts` (create) | the pure function, and the zsh snippet run for real |
| `tests/unit/shellInstall.test.ts` (create) | the zshrc edit, its idempotency, and uninstall |
| `tests/integration/history.test.ts` (create) | the IPC handler against a temp history file |
| `tests/e2e/history.spec.ts` (create) | open, navigate, type onto the prompt, dismiss, and passthrough |

---

### Task 1: The history record and the pure selection function

**Files:**
- Create: `src/main/shell/history.ts`
- Test: `tests/unit/shellHistory.test.ts`

**Interfaces:**
- Consumes: `configRoot()` from `src/main/state/store.ts`
- Produces: `HistoryEntry`, `HistoryScope`, `historyPath()`, `parseHistory(text)`, `selectHistory(entries, options)`, `readHistory(limit?)`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/shellHistory.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseHistory, selectHistory, type HistoryEntry } from '../../src/main/shell/history'

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  ts: 1,
  cwd: '/Users/x/Code/PRCLI',
  tab: 'tab1',
  cmd: 'ls',
  ...over,
})

describe('parseHistory', () => {
  it('reads one entry per line', () => {
    const text = '{"ts":1,"cwd":"/a","tab":"t","cmd":"ls"}\n{"ts":2,"cwd":"/a","tab":"t","cmd":"pwd"}\n'
    expect(parseHistory(text).map((e) => e.cmd)).toEqual(['ls', 'pwd'])
  })

  // A half-written line is the normal state of a file being appended to by a
  // live shell, so it must cost that line and nothing else.
  it('skips a malformed line rather than failing the whole read', () => {
    const text = '{"ts":1,"cwd":"/a","tab":"t","cmd":"ls"}\nnot json\n{"ts":2,"cwd":"/a","tab":"t","cmd":"pwd"}\n'
    expect(parseHistory(text).map((e) => e.cmd)).toEqual(['ls', 'pwd'])
  })

  it('skips a line that parses but is not a history entry', () => {
    expect(parseHistory('{"ts":1}\n[]\n"str"\n')).toEqual([])
  })
})

describe('selectHistory', () => {
  const project = '/Users/x/Code/PRCLI'

  it('returns newest first', () => {
    const got = selectHistory(
      [entry({ ts: 1, cmd: 'first' }), entry({ ts: 2, cmd: 'second' })],
      { scope: 'all', projectCwd: project },
    )
    expect(got.map((e) => e.cmd)).toEqual(['second', 'first'])
  })

  it('keeps only the current project when scope is project, including subdirectories', () => {
    const got = selectHistory(
      [
        entry({ ts: 1, cwd: project, cmd: 'inRoot' }),
        entry({ ts: 2, cwd: `${project}/src/main`, cmd: 'inSub' }),
        entry({ ts: 3, cwd: '/Users/x/Code/Lumio', cmd: 'elsewhere' }),
      ],
      { scope: 'project', projectCwd: project },
    )
    expect(got.map((e) => e.cmd)).toEqual(['inSub', 'inRoot'])
  })

  // A sibling directory whose name merely starts with the project's must not
  // match. The separator is the whole of the check.
  it('does not treat a sibling with a shared prefix as inside the project', () => {
    const got = selectHistory(
      [entry({ ts: 1, cwd: `${project}-old`, cmd: 'sibling' })],
      { scope: 'project', projectCwd: project },
    )
    expect(got).toEqual([])
  })

  it('ignores the project when scope is all', () => {
    const got = selectHistory(
      [entry({ ts: 1, cwd: '/somewhere/else', cmd: 'elsewhere' })],
      { scope: 'all', projectCwd: project },
    )
    expect(got.map((e) => e.cmd)).toEqual(['elsewhere'])
  })

  it('filters by case-insensitive substring', () => {
    const got = selectHistory(
      [entry({ ts: 1, cmd: 'git push' }), entry({ ts: 2, cmd: 'npm test' })],
      { scope: 'all', projectCwd: project, filter: 'GIT' },
    )
    expect(got.map((e) => e.cmd)).toEqual(['git push'])
  })

  it('dedupes repeated commands, keeping the most recent', () => {
    const got = selectHistory(
      [entry({ ts: 1, cmd: 'npm test' }), entry({ ts: 2, cmd: 'ls' }), entry({ ts: 3, cmd: 'npm test' })],
      { scope: 'all', projectCwd: project },
    )
    expect(got.map((e) => e.cmd)).toEqual(['npm test', 'ls'])
    expect(got[0].ts).toBe(3)
  })

  it('caps the result at the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => entry({ ts: i, cmd: `cmd${i}` }))
    expect(selectHistory(many, { scope: 'all', projectCwd: project, limit: 3 })).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shellHistory.test.ts`
Expected: FAIL, cannot resolve `../../src/main/shell/history`.

- [ ] **Step 3: Write the implementation**

Create `src/main/shell/history.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configRoot } from '../state/store'

export interface HistoryEntry {
  /** Epoch seconds, as written by the zsh hook. */
  ts: number
  cwd: string
  /** The pane's PRCLI_TAB_ID at the time the command ran. */
  tab: string
  cmd: string
}

export type HistoryScope = 'project' | 'all'

export interface SelectOptions {
  scope: HistoryScope
  projectCwd: string
  filter?: string
  limit?: number
}

export function historyPath(): string {
  return join(configRoot(), 'history.jsonl')
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.ts === 'number' &&
    typeof record.cwd === 'string' &&
    typeof record.tab === 'string' &&
    typeof record.cmd === 'string'
  )
}

export function parseHistory(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isEntry(parsed)) entries.push(parsed)
    } catch {
      continue
    }
  }
  return entries
}

function inProject(cwd: string, projectCwd: string): boolean {
  return cwd === projectCwd || cwd.startsWith(`${projectCwd}/`)
}

export function selectHistory(entries: HistoryEntry[], options: SelectOptions): HistoryEntry[] {
  const { scope, projectCwd, filter, limit = 500 } = options
  const needle = filter?.toLowerCase() ?? ''
  const seen = new Set<string>()
  const picked: HistoryEntry[] = []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]
    if (scope === 'project' && !inProject(candidate.cwd, projectCwd)) continue
    if (needle !== '' && !candidate.cmd.toLowerCase().includes(needle)) continue
    if (seen.has(candidate.cmd)) continue
    seen.add(candidate.cmd)
    picked.push(candidate)
    if (picked.length === limit) break
  }
  return picked
}

export async function readHistory(limit = 5000): Promise<HistoryEntry[]> {
  let text: string
  try {
    text = await readFile(historyPath(), 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n')
  return parseHistory(lines.slice(Math.max(0, lines.length - limit)).join('\n'))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/shellHistory.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/main/shell/history.ts tests/unit/shellHistory.test.ts
git commit -m "Read and scope the shell history file"
```

---

### Task 2: The zsh snippet, proven by running zsh

**Files:**
- Create: `src/main/shell/install.ts`
- Modify: `tests/unit/shellHistory.test.ts` (append the snippet tests)

**Interfaces:**
- Consumes: `historyPath()` from Task 1
- Produces: `renderHistoryScript(historyFile)`, `shellPaths()`

This task covers only the script's TEXT and its runtime behaviour. The `~/.zshrc` edit is Task 3.

The snippet is the one piece of this feature that is not TypeScript and cannot be typechecked, so it is tested by actually running zsh. JSON escaping is the reason: a command containing a double quote or a backslash must not produce a line that `parseHistory` throws away.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/shellHistory.test.ts`:

```ts
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { renderHistoryScript } from '../../src/main/shell/install'

const run = promisify(execFile)

/** Sources the snippet in a real zsh, runs `command`, and returns the file it wrote. */
async function recordViaZsh(command: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prcli-hist-'))
  const historyFile = join(dir, 'history.jsonl')
  const scriptFile = join(dir, 'prcli-history.zsh')
  await writeFile(scriptFile, renderHistoryScript(historyFile), 'utf8')
  // `-i` so preexec hooks run at all: zsh only runs them for interactive shells.
  await run('zsh', ['-i', '-c', `source ${scriptFile}; ${command}`], {
    env: { ...process.env, PRCLI_TAB_ID: 'tab-under-test' },
  })
  return readFile(historyFile, 'utf8')
}

describe('the zsh snippet', () => {
  it('records a command as a parseable entry carrying cwd and tab id', async () => {
    const written = await recordViaZsh('true')
    const entries = parseHistory(written)
    const recorded = entries.find((e) => e.cmd.includes('true'))
    expect(recorded).toBeDefined()
    expect(recorded?.tab).toBe('tab-under-test')
    expect(recorded?.cwd).not.toBe('')
    expect(recorded?.ts).toBeGreaterThan(0)
  }, 20_000)

  // The failure this exists to prevent: an unescaped quote makes the line
  // invalid JSON, so `parseHistory` drops it and the command silently never
  // appears in the overlay.
  it('escapes double quotes and backslashes so the line stays parseable', async () => {
    const written = await recordViaZsh(String.raw`echo "a\"b" > /dev/null`)
    const entries = parseHistory(written)
    expect(entries.some((e) => e.cmd.includes('echo'))).toBe(true)
  }, 20_000)

  it('records nothing when PRCLI_TAB_ID is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prcli-hist-'))
    const historyFile = join(dir, 'history.jsonl')
    const scriptFile = join(dir, 'prcli-history.zsh')
    await writeFile(scriptFile, renderHistoryScript(historyFile), 'utf8')
    const env = { ...process.env }
    delete env.PRCLI_TAB_ID
    await run('zsh', ['-i', '-c', `source ${scriptFile}; true`], { env })
    await expect(readFile(historyFile, 'utf8')).rejects.toThrow()
  }, 20_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shellHistory.test.ts`
Expected: FAIL, cannot resolve `../../src/main/shell/install`.

- [ ] **Step 3: Write the implementation**

Create `src/main/shell/install.ts`:

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configRoot } from '../state/store'
import { historyPath } from './history'

export function shellPaths(): { rcPath: string; scriptPath: string; historyFile: string } {
  return {
    // PRCLI_ZSHRC is a test seam, for the reason PRCLI_CONFIG_DIR is one:
    // without it a test run edits the developer's real shell config.
    rcPath: process.env.PRCLI_ZSHRC ?? join(homedir(), '.zshrc'),
    // Beside the existing prcli-hook, which hookPaths() places the same way.
    scriptPath: join(configRoot(), 'bin', 'prcli-history.zsh'),
    historyFile: historyPath(),
  }
}

export function renderHistoryScript(historyFile: string): string {
  return [
    '# Written by PRCLI. Edits are overwritten on reinstall.',
    'typeset -g PRCLI_HISTORY_FILE=' + JSON.stringify(historyFile),
    '',
    'prcli_history_preexec() {',
    '  [ -n "$PRCLI_TAB_ID" ] || return 0',
    '  local cmd=$1',
    '  cmd=${cmd//\\\\/\\\\\\\\}',
    '  cmd=${cmd//\\"/\\\\\\"}',
    "  cmd=${cmd//$'\\n'/ }",
    '  cmd=${cmd//$\'\\t\'/ }',
    '  printf \'{"ts":%d,"cwd":"%s","tab":"%s","cmd":"%s"}\\n\' \\',
    '    "$EPOCHSECONDS" "$PWD" "$PRCLI_TAB_ID" "$cmd" >> "$PRCLI_HISTORY_FILE"',
    '}',
    '',
    'zmodload -F zsh/datetime +p:EPOCHSECONDS 2>/dev/null',
    'autoload -Uz add-zsh-hook',
    'add-zsh-hook preexec prcli_history_preexec',
    '',
  ].join('\n')
}
```

Note for the implementer: the escaping lines above are TypeScript string literals producing zsh parameter expansions. Read the file zsh actually receives (the test writes it to a temp dir) before assuming the escaping is right. `$PWD` is not escaped because a directory containing a double quote is not a case this app supports; if the test proves otherwise, escape it the same way.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/shellHistory.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/install.ts tests/unit/shellHistory.test.ts
git commit -m "Record each command from a zsh preexec hook"
```

---

### Task 3: Installing and uninstalling the zshrc block

**Files:**
- Modify: `src/main/shell/install.ts`
- Test: `tests/unit/shellInstall.test.ts` (create)

**Interfaces:**
- Consumes: `shellPaths()`, `renderHistoryScript()` from Task 2
- Produces: `ShellHistoryState`, `MARKER_START`, `MARKER_END`, `block(scriptPath)`, `isInstalled(rc)`, `merge(rc, scriptPath)`, `unmerge(rc)`, `readShellHistoryState()`, `installShellHistory()`, `uninstallShellHistory()`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/shellInstall.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MARKER_END, MARKER_START, block, isInstalled, merge, unmerge } from '../../src/main/shell/install'

const script = '/Users/x/.prcli/bin/prcli-history.zsh'

describe('the zshrc block', () => {
  it('is bounded by markers so uninstall can be exact', () => {
    expect(block(script).startsWith(MARKER_START)).toBe(true)
    expect(block(script).trimEnd().endsWith(MARKER_END)).toBe(true)
    expect(block(script)).toContain(script)
  })

  it('reports not installed for an rc that has never seen it', () => {
    expect(isInstalled('export PATH=/usr/bin\n')).toBe(false)
  })

  it('appends the block, preserving what was already there', () => {
    const merged = merge('export PATH=/usr/bin\n', script)
    expect(merged.startsWith('export PATH=/usr/bin\n')).toBe(true)
    expect(isInstalled(merged)).toBe(true)
  })

  // Installing twice must not leave two blocks: the hook would then be
  // registered twice and every command recorded twice.
  it('is idempotent', () => {
    const once = merge('export PATH=/usr/bin\n', script)
    const twice = merge(once, script)
    expect(twice).toBe(once)
    expect(twice.split(MARKER_START)).toHaveLength(2)
  })

  it('removes exactly what it added', () => {
    const original = 'export PATH=/usr/bin\nalias g=git\n'
    expect(unmerge(merge(original, script))).toBe(original)
  })

  it('leaves an rc it never touched alone', () => {
    const original = 'export PATH=/usr/bin\n'
    expect(unmerge(original)).toBe(original)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shellInstall.test.ts`
Expected: FAIL, `block` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/main/shell/install.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface ShellHistoryState {
  installed: boolean
  rcPath: string
  scriptPath: string
  /** The exact text install would add, so the screen can show it first. */
  pending: string
}

export const MARKER_START = '# >>> prcli shell history >>>'
export const MARKER_END = '# <<< prcli shell history <<<'

export function block(scriptPath: string): string {
  return [MARKER_START, `[ -f ${JSON.stringify(scriptPath)} ] && source ${JSON.stringify(scriptPath)}`, MARKER_END, ''].join('\n')
}

export function isInstalled(rc: string): boolean {
  return rc.includes(MARKER_START)
}

export function merge(rc: string, scriptPath: string): string {
  if (isInstalled(rc)) return rc
  const separator = rc === '' || rc.endsWith('\n') ? '' : '\n'
  return `${rc}${separator}${block(scriptPath)}`
}

export function unmerge(rc: string): string {
  const start = rc.indexOf(MARKER_START)
  if (start === -1) return rc
  const end = rc.indexOf(MARKER_END, start)
  if (end === -1) return rc
  const after = end + MARKER_END.length
  return rc.slice(0, start) + rc.slice(after).replace(/^\n/, '')
}

async function readRc(rcPath: string): Promise<string> {
  try {
    return await readFile(rcPath, 'utf8')
  } catch {
    return ''
  }
}

export async function readShellHistoryState(): Promise<ShellHistoryState> {
  const { rcPath, scriptPath } = shellPaths()
  return {
    installed: isInstalled(await readRc(rcPath)),
    rcPath,
    scriptPath,
    pending: block(scriptPath),
  }
}

export async function installShellHistory(): Promise<ShellHistoryState> {
  const { rcPath, scriptPath, historyFile } = shellPaths()
  await mkdir(dirname(scriptPath), { recursive: true })
  await writeFile(scriptPath, renderHistoryScript(historyFile), 'utf8')
  await writeFile(rcPath, merge(await readRc(rcPath), scriptPath), 'utf8')
  return readShellHistoryState()
}

export async function uninstallShellHistory(): Promise<ShellHistoryState> {
  const { rcPath } = shellPaths()
  await writeFile(rcPath, unmerge(await readRc(rcPath)), 'utf8')
  return readShellHistoryState()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/shellInstall.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/install.ts tests/unit/shellInstall.test.ts
git commit -m "Install the history hook into zshrc between markers"
```

---

### Task 4: The IPC surface

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc/register.ts`
- Test: `tests/integration/history.test.ts` (create)

**Interfaces:**
- Consumes: `readHistory()`, `selectHistory()` from Task 1; the install functions from Task 3
- Produces: `CHANNELS.historyList`, `CHANNELS.shellHistoryState`, `CHANNELS.installShellHistory`, `CHANNELS.uninstallShellHistory`, and the matching `PrcliApi` members

- [ ] **Step 1: Write the failing test**

Create `tests/integration/history.test.ts`. Follow the harness already used by `tests/integration/persistence.test.ts`: read its top-of-file setup and copy how it points `PRCLI_CONFIG_DIR` at a temp directory and how it invokes a channel. Then:

```ts
it('returns this project\'s commands, newest first', async () => {
  await writeFile(join(configDir, 'history.jsonl'), [
    JSON.stringify({ ts: 1, cwd: projectCwd, tab: 't', cmd: 'npm test' }),
    JSON.stringify({ ts: 2, cwd: '/elsewhere', tab: 't', cmd: 'other' }),
    JSON.stringify({ ts: 3, cwd: projectCwd, tab: 't', cmd: 'git push' }),
    '',
  ].join('\n'))

  const entries = await invoke<HistoryEntry[]>(CHANNELS.historyList, projectCwd, 'project')
  expect(entries.map((e) => e.cmd)).toEqual(['git push', 'npm test'])
})

it('returns an empty list rather than throwing when no history file exists', async () => {
  const entries = await invoke<HistoryEntry[]>(CHANNELS.historyList, projectCwd, 'project')
  expect(entries).toEqual([])
})

it('widens to every project when asked', async () => {
  await writeFile(join(configDir, 'history.jsonl'),
    `${JSON.stringify({ ts: 1, cwd: '/elsewhere', tab: 't', cmd: 'other' })}\n`)
  const entries = await invoke<HistoryEntry[]>(CHANNELS.historyList, projectCwd, 'all')
  expect(entries.map((e) => e.cmd)).toEqual(['other'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/history.test.ts`
Expected: FAIL, `CHANNELS.historyList` is undefined.

- [ ] **Step 3: Add the channels and types**

In `src/shared/ipc.ts`, add to `CHANNELS`:

```ts
  historyList: 'prcli:historyList',
  shellHistoryState: 'prcli:shellHistoryState',
  installShellHistory: 'prcli:installShellHistory',
  uninstallShellHistory: 'prcli:uninstallShellHistory',
```

Re-declare the two shapes the renderer draws, beside `HooksState`, which is there for the same reason: the renderer cannot import from `src/main`.

```ts
export interface HistoryEntry {
  ts: number
  cwd: string
  tab: string
  cmd: string
}

export type HistoryScope = 'project' | 'all'

export interface ShellHistoryState {
  installed: boolean
  rcPath: string
  scriptPath: string
  pending: string
}
```

Add to the `PrcliApi` interface:

```ts
  historyList(projectCwd: string, scope: HistoryScope): Promise<HistoryEntry[]>
  shellHistoryState(): Promise<ShellHistoryState>
  installShellHistory(): Promise<ShellHistoryState>
  uninstallShellHistory(): Promise<ShellHistoryState>
```

Have `src/main/shell/history.ts` and `src/main/shell/install.ts` import and re-export these types rather than declaring their own second copies.

- [ ] **Step 4: Bridge them in the preload**

In `src/preload/index.ts`, beside the `hooksState` line:

```ts
  historyList: (projectCwd, scope) => ipcRenderer.invoke(CHANNELS.historyList, projectCwd, scope),
  shellHistoryState: () => ipcRenderer.invoke(CHANNELS.shellHistoryState),
  installShellHistory: () => ipcRenderer.invoke(CHANNELS.installShellHistory),
  uninstallShellHistory: () => ipcRenderer.invoke(CHANNELS.uninstallShellHistory),
```

- [ ] **Step 5: Add the handlers**

In `src/main/ipc/register.ts`, beside the hooks handlers. These read the file fresh on every call for the reason `hooksState` does: another window, or the user's own editor, may have changed it.

```ts
  ipcMain.handle(
    CHANNELS.historyList,
    async (_event, projectCwd: string, scope: HistoryScope): Promise<HistoryEntry[]> =>
      selectHistory(await readHistory(), { scope, projectCwd }),
  )
  ipcMain.handle(CHANNELS.shellHistoryState, () => readShellHistoryState())
  ipcMain.handle(CHANNELS.installShellHistory, () => installShellHistory())
  ipcMain.handle(CHANNELS.uninstallShellHistory, () => uninstallShellHistory())
```

- [ ] **Step 6: Run test and typecheck**

Run: `npx vitest run tests/integration/history.test.ts && npx tsc --noEmit`
Expected: PASS, 3 tests, and no typecheck output.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/ipc/register.ts src/main/shell tests/integration/history.test.ts
git commit -m "Serve scoped shell history over IPC"
```

---

### Task 5: The Settings row

**Files:**
- Modify: `src/renderer/SettingsPane.tsx`

**Interfaces:**
- Consumes: `shellHistoryState()`, `installShellHistory()`, `uninstallShellHistory()` from Task 4

- [ ] **Step 1: Read the existing hooks row**

Read `src/renderer/SettingsPane.tsx` from the `hooksState` fetch through the end of the hooks row's JSX. The new row mirrors it: same fetch-on-open pattern, same error state, same disabled-while-pending handling. Do not invent a different shape.

- [ ] **Step 2: Add the row**

Add a `shellHistory` state alongside `hooks`, fetched in the same effect, and render a row that:

- names the file it will edit (`state.rcPath`) and the script it will write (`state.scriptPath`)
- shows `state.pending` in the same pre-formatted block the hooks row uses for its own pending JSON
- offers Install when `installed` is false and Uninstall when it is true
- states, in visible copy, that only panes started after installing will record anything

That last line is required. Without it the first thing a user sees after installing is an empty overlay in every pane they already had open, which reads as the feature being broken.

- [ ] **Step 3: Verify by running the app**

Run: `npm start`
Open Settings. Confirm the row renders, the pending text matches what `block()` produces, and Install then Uninstall leaves your `~/.zshrc` byte-for-byte as it started.

Before you run this: set `PRCLI_ZSHRC` to a temp file for the manual check, or you are testing against your own shell config.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/SettingsPane.tsx
git commit -m "Offer shell history install from Settings"
```

---

### Task 6: The overlay, and the one intercepted key

**Files:**
- Create: `src/renderer/HistoryOverlay.tsx`
- Modify: `src/renderer/Terminal.tsx`, `src/renderer/App.tsx`
- Modify: `tests/e2e/harness.ts`
- Test: `tests/e2e/history.spec.ts` (create)

**Interfaces:**
- Consumes: `historyList()` from Task 4
- Produces: `capturePane(socket, session)` in the e2e harness

- [ ] **Step 1: Add the capture helper**

`tests/e2e/harness.ts` has `sessionNames` but nothing that reads a pane's contents, and the central assertion of this feature is what ended up on the prompt. Add beside `sessionNames`, following its `assertTestSocket` and try/catch shape:

```ts
export async function capturePane(socket: string, session: string): Promise<string> {
  assertTestSocket(socket)
  try {
    const { stdout } = await run('tmux', ['-L', socket, 'capture-pane', '-p', '-t', session])
    return stdout
  } catch {
    return ''
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/e2e/history.spec.ts`, copying the `beforeEach`/`afterEach`/`launch` scaffolding from `tests/e2e/splits.spec.ts` but with its own socket name and its own temp `PRCLI_CONFIG_DIR` and `PRCLI_ZSHRC`. Seed a history file before launching, so the list has content without needing a real shell to have run anything.

```ts
test('Up opens history, arrows move, and Enter types the command onto the prompt', async () => {
  await writeFile(join(configDir, 'history.jsonl'), [
    JSON.stringify({ ts: 1, cwd: projectCwd, tab: 't', cmd: 'echo older' }),
    JSON.stringify({ ts: 2, cwd: projectCwd, tab: 't', cmd: 'echo newer' }),
    '',
  ].join('\n'))

  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)

  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toBeVisible()
  // Newest first, so the first row is selected and is the newer command.
  await expect(window.getByTestId('history-row-0')).toHaveAttribute('data-selected', 'true')
  await expect(window.getByTestId('history-row-0')).toHaveText(/echo newer/)

  await window.keyboard.press('ArrowDown')
  await expect(window.getByTestId('history-row-1')).toHaveAttribute('data-selected', 'true')

  await window.keyboard.press('Enter')
  await expect(window.getByTestId('history-overlay')).toBeHidden()

  // The claim: the text is ON THE PROMPT, and was not run. Read from tmux, not
  // from the DOM, because the DOM cannot tell those two apart.
  const session = (await sessionNames(SOCKET))[0]
  await expect.poll(async () => await capturePane(SOCKET, session), { timeout: 20_000 })
    .toContain('echo older')
  expect(await capturePane(SOCKET, session)).not.toContain('older\n')
})

test('Esc dismisses without typing anything', async () => {
  // Same seeding and launch as above, then:
  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(window.getByTestId('history-overlay')).toBeHidden()
  const session = (await sessionNames(SOCKET))[0]
  expect(await capturePane(SOCKET, session)).not.toContain('echo')
})

// The rule from the spec: with nothing to show, Up must still belong to zsh.
test('Up reaches the shell when there is no history to show', async () => {
  // Launch with NO history file seeded.
  await window.keyboard.press('ArrowUp')
  await expect(window.getByTestId('history-overlay')).toHaveCount(0)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx playwright test tests/e2e/history.spec.ts`
Expected: FAIL, no element with testid `history-overlay`.

- [ ] **Step 4: Write the overlay**

Create `src/renderer/HistoryOverlay.tsx`. It takes the entries, the scope, and three callbacks (`onPick`, `onScopeChange`, `onDismiss`), owns the selected index and the filter text, and renders absolutely positioned against the pane box with `bottom: 0`. It must:

- give the root `data-testid="history-overlay"` and each row `data-testid={`history-row-${index}`}` with `data-selected`
- handle `ArrowUp`/`ArrowDown` (clamped, no wrap), `Escape`, `Enter`, and `Tab` for the scope toggle
- take DOM focus on mount, so xterm loses it and no further xterm interception is needed
- show each entry's command and a relative time derived from `ts`

Radix is available and the app already uses it for dialogs, but this is not a dialog: it is anchored inside a pane and must not trap focus at the window level. Build it as a plain focused `div`.

- [ ] **Step 5: Intercept the one key**

In `src/renderer/Terminal.tsx`, after `term.open(container)`, add a handler that returns `false` only for the Up that should open the overlay, and `true` for everything else so xterm behaves exactly as it does today:

```ts
term.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown') return true
  if (event.key !== 'ArrowUp') return true
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true
  return !onHistoryRequested()
})
```

`onHistoryRequested` is a new prop: a function returning `true` if it opened the overlay, `false` if it declined (wrong pane type, no history, already open). The declining case is what makes `return true` send `\x1b[A` to the pty as before.

- [ ] **Step 6: Wire it in App.tsx**

`App.tsx` owns which pane's overlay is open, since it already owns `activePaneId` and the pane list. On a request it looks up the pane's `type`, returns `false` unless it is `shell`, otherwise fetches `historyList(project.cwd, scope)` and opens only if the result is non-empty. On pick it calls `window.prcli.input(paneId, cmd)`, which is the existing channel the Prompts and Skills panels already use to type into a pane.

Because the fetch is asynchronous and `attachCustomKeyEventHandler` must answer synchronously, keep the current project's entries in state, refreshed when the overlay closes and when the active project changes. The synchronous answer is then "do I have any entries for this pane's project", which is what decides whether Up is swallowed.

- [ ] **Step 7: Run the tests**

Run: `npx playwright test tests/e2e/history.spec.ts && npx tsc --noEmit`
Expected: PASS, 3 tests.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/HistoryOverlay.tsx src/renderer/Terminal.tsx src/renderer/App.tsx tests/e2e/harness.ts tests/e2e/history.spec.ts
git commit -m "Open history from Up and type the chosen command"
```

---

### Task 7: Prove the new tests can fail, then run everything

**Files:** none changed permanently.

- [ ] **Step 1: Sabotage the scope filter**

In `selectHistory`, change `if (scope === 'project' && !inProject(...)) continue` to never skip.
Run: `npx vitest run tests/unit/shellHistory.test.ts tests/integration/history.test.ts`
Expected: FAIL. Record which tests failed. Revert.

- [ ] **Step 2: Sabotage the dedupe**

Remove the `seen` check.
Run: `npx vitest run tests/unit/shellHistory.test.ts`
Expected: FAIL on the dedupe test only. Revert.

- [ ] **Step 3: Sabotage the escaping**

Remove the two `cmd=${cmd//...}` lines from the zsh snippet.
Run: `npx vitest run tests/unit/shellHistory.test.ts`
Expected: FAIL on the quote-escaping test. Revert.

- [ ] **Step 4: Sabotage the passthrough rule**

Make `onHistoryRequested` always return `true`.
Run: `npx playwright test tests/e2e/history.spec.ts`
Expected: FAIL on "Up reaches the shell when there is no history to show". Revert.

- [ ] **Step 5: Sabotage the typing**

Change `onPick` to close the overlay without calling `window.prcli.input`.
Run: `npx playwright test tests/e2e/history.spec.ts`
Expected: FAIL on the capture-pane assertion. Revert.

If any of these five sabotages leaves the suite green, that test is not testing what its name says. Fix the test, not the sabotage.

- [ ] **Step 6: Run everything**

Run: `npx tsc --noEmit && npm test && npx playwright test`
Expected: typecheck silent, unit and integration green, e2e green.

A note on reading a red e2e run here: this suite intermittently fails `columns.spec.ts` under load, and those tests pass when run alone. Confirm any failure by re-running the single file before treating it as caused by this work.

- [ ] **Step 7: Commit**

```bash
git commit --allow-empty -m "Record the sabotage results for the history overlay tests"
```

Put the actual observed failures in that commit message, one line each. A sabotage whose result is not written down has to be redone by the next person who wonders.

---

## Self-Review

**Spec coverage:** Trigger and passthrough rules, Task 6. Source and shell integration, Tasks 2 and 3. Settings row, Task 5. Scope with a Tab toggle, Tasks 1, 4 and 6. Enter types without running, Task 6. Placement anchored to the pane, Task 6. Bounded read and dedupe, Task 1. Malformed-line tolerance, Task 1. Testing section, Tasks 1 through 7.

**Not covered, deliberately:** the spec's closing note about the test suite polluting the developer's real `~/.zsh_history` is a pre-existing defect and is not fixed here. `PRCLI_ZSHRC` in Task 2 stops this feature from adding a second instance of it. The existing pollution needs its own task.

**Type consistency:** `HistoryEntry`, `HistoryScope` and `ShellHistoryState` are declared once in `src/shared/ipc.ts` (Task 4) and re-exported by the main modules, so the two copies that would otherwise drift do not exist. `selectHistory` takes `SelectOptions`, used identically in Tasks 1 and 4. `capturePane(socket, session)` is defined in Task 6 Step 1 and used in Task 6 Step 2.

**Ordering note:** Task 1 and Task 2 both write `tests/unit/shellHistory.test.ts`, and Task 2 and Task 3 both write `src/main/shell/install.ts`. They are sequential for that reason and must not be parallelised.
