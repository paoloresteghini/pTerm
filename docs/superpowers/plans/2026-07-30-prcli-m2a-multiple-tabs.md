# PRCLI Milestone 2a — Multiple Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several terminals in one window, switchable from a tab bar, surviving restart — with exactly one app instance and no session the UI cannot reach.

**Architecture:** Milestone 1 already runs any number of tmux-backed sessions; only the renderer was single-tab. This milestone adds a tab bar over the existing `SessionManager`, and inverts the source of truth for restore: **live tmux sessions decide what exists, config only records order and which tab was active.** That makes a stray session visible instead of invisible, and lets dead config rows prune themselves.

**Tech Stack:** Unchanged from M1 — Electron 43.2.0, TypeScript (strict), Vite via Electron Forge 7.11.2, node-pty 1.1.0, @xterm/xterm 6.0.0, React 19, Vitest 4.1.10, Playwright 1.62.0, tmux ≥ 3.3.

## Global Constraints

- Platform: macOS only. No Windows or Linux branches.
- All tmux invocations go through `TmuxAdapter`. No `execFile('tmux', …)` anywhere else.
- Every tmux session name is `prcli-<projectSlug>-<id>`, built only via `encodeSessionName`.
- Integration tests use a dedicated tmux socket (`-L prcli-test`); E2E uses `PRCLI_TMUX_SOCKET=prcli-e2e`. Neither may ever touch the developer's own tmux server.
- Tests must never read or write the real `~/.prcli` — use `PRCLI_CONFIG_DIR`.
- `node-pty` is main-process only; renderer code imports no Node built-ins and reaches privilege only through `window.prcli`.
- `tsconfig.json` has `"strict": true`. Keep it clean — no `any`, no non-null assertions, no `@ts-` suppressions.
- The durable record and the attached-client set are different things. Never derive one from the other, and never infer a session's death from a client's death.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- Spec: `docs/superpowers/specs/2026-07-30-prcli-design.md`. M1 plan and its corrections: `docs/superpowers/plans/2026-07-30-prcli-m1-terminal-core.md`.

## Existing interfaces this milestone builds on

- `src/main/tmux/adapter.ts` — `TmuxAdapter({ bin?, socket? })` with `readonly bin`, `baseArgs()`, `version()`, `listSessions()`, `listPrcliSessions()`, `hasSession(name)`, `killSession(name)`; `TmuxNotInstalledError`
- `src/main/tmux/names.ts` — `slugify`, `newSessionId`, `encodeSessionName({projectSlug, id})`, `decodeSessionName(name)`, `isPrcliSession(name)`
- `src/main/pty/session.ts` — `PtySession(adapter, { tmuxSession, cwd, cols, rows, command?, env? })` with `start()`, `write()`, `resize()`, `detach()`, `onData()`, `onExit()`
- `src/main/sessions/manager.ts` — `SessionManager(adapter)` with `open(OpenInput)`, `get(id)`, `list()`, `write()`, `resize()`, `detach(id)`, `detachAll()`, `kill(id)`, `hasSession(name)`, `findOrphans()`, `onData((id, data))`, `onExit((record, code, reason))`; types `TabRecord`, `OpenInput`, `ExitReason = 'detached' | 'killed' | 'exited'`
- `src/main/state/store.ts` — `ConfigStore(filePath)` with `read()`, `write(config)`, `static defaultPath()`; `PrcliConfig`
- `src/shared/ipc.ts` — `CHANNELS`, `TabDescriptor`, `OpenRequest`, `DataEvent`, `ExitEvent`, `PrcliApi`

## File Structure

| File | Responsibility |
|---|---|
| `src/main/index.ts` (modify) | Add the single-instance lock; focus the existing window on a second launch |
| `src/main/tmux/adapter.ts` (modify) | Add `setSessionOption` / `getSessionOption` |
| `src/main/pty/session.ts` (modify) | Chain `set-option status off` onto the `new-session` invocation |
| `src/main/state/store.ts` (modify) | Config v2: `activeTabId` plus tab order; migrate v1 |
| `src/main/ipc/register.ts` (modify) | Restore from live tmux; add `setActive`; prune dead rows |
| `src/shared/ipc.ts` (modify) | `RestoreResult`, `setActive` channel |
| `src/renderer/tabs.ts` | Pure tabs reducer — state transitions, no React, no I/O |
| `src/renderer/TabBar.tsx` | Presentational tab strip: labels, active state, close buttons, `+` |
| `src/renderer/App.tsx` (rewrite) | Owns tab state, mounts every terminal, keyboard shortcuts |
| `src/renderer/Terminal.tsx` (modify) | Skip fitting while hidden; refit on becoming visible |
| `tests/unit/tabs.test.ts` | Reducer transitions |
| `tests/unit/store.test.ts` (modify) | v1→v2 migration |
| `tests/integration/adapter.test.ts` (modify) | Session options |
| `tests/integration/session.test.ts` (modify) | Status bar disabled on create |
| `tests/integration/restore.test.ts` | Restore adopts orphans, prunes dead rows, honours order |
| `tests/e2e/tabs.spec.ts` | Multi-tab, switching, persistence, second-instance focus |

---

### Task 1: Single-instance lock

Two instances currently each open their own sessions and share one config file. This is the defect that produced three stray sessions in real use.

**Files:**
- Modify: `src/main/index.ts`
- Test: `tests/e2e/tabs.spec.ts` (create)

**Interfaces:**
- Consumes: nothing new
- Produces: a second launch exits without creating sessions and focuses the first window

- [ ] **Step 1: Write the failing E2E test**

Create `tests/e2e/tabs.spec.ts`:

```ts
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const SOCKET = 'prcli-e2e-tabs'

let userDataDir: string
let configDir: string

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PRCLI_CONFIG_DIR: configDir, PRCLI_TMUX_SOCKET: SOCKET },
  })
}

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

async function sessionNames(): Promise<string[]> {
  try {
    const { stdout } = await run('tmux', ['-L', SOCKET, 'list-sessions', '-F', '#{session_name}'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

test.beforeAll(async () => {
  await run('npm', ['run', 'package'])
})

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-tabs-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-tabs-config-'))
})

test.afterEach(async () => {
  await killServer()
  await rm(userDataDir, { recursive: true, force: true })
  await rm(configDir, { recursive: true, force: true })
})

test('a second instance exits instead of opening its own session', async () => {
  const first = await launch()
  await expect(first.firstWindow().then((w) => w.getByTestId('terminal-active'))).resolves.toBeTruthy()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(1)

  // A second launch must not create a second session.
  const second = await launch()
  const exitCode = await second.evaluate(({ app }) => app.getVersion()).then(
    () => 'still running',
    () => 'exited',
  )
  expect(exitCode).toBe('exited')
  await expect.poll(async () => (await sessionNames()).length, { timeout: 10_000 }).toBe(1)

  await first.close()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run e2e -- tests/e2e/tabs.spec.ts`
Expected: FAIL — a second session is created, so the poll sees 2.

- [ ] **Step 3: Implement the lock**

In `src/main/index.ts`, immediately after the `const manager = new SessionManager(adapter)` line, add:

```ts
// Two instances would each open their own sessions and race on one config
// file. Real usage hit exactly that: three stray sessions, none reachable
// from the UI.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
}

app.on('second-instance', () => {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})
```

Then guard startup — wrap the existing `app.whenReady().then(...)` body so it does nothing on a secondary instance. Change the first line inside the callback from:

```ts
app.whenReady().then(async () => {
  try {
```

to:

```ts
app.whenReady().then(async () => {
  if (!isPrimaryInstance) return
  try {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run e2e -- tests/e2e/tabs.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck && npm run e2e`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts tests/e2e/tabs.spec.ts
git commit -m "$(cat <<'EOF'
Allow only one app instance

Two instances each opened their own sessions and raced on one config
file, which in real use left three tmux sessions none of the windows
could reach. A second launch now focuses the first window and exits.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Session options, and tmux's status bar off

tmux draws its own green status line at the bottom of every session. The app is about to draw a tab bar in the same place, so app-managed sessions must not.

**Files:**
- Modify: `src/main/tmux/adapter.ts`, `src/main/pty/session.ts`
- Test: `tests/integration/adapter.test.ts`, `tests/integration/session.test.ts`

**Interfaces:**
- Consumes: `TmuxAdapter.exec` (private), `baseArgs()`
- Produces:
  - `TmuxAdapter.setSessionOption(name: string, option: string, value: string): Promise<void>`
  - `TmuxAdapter.getSessionOption(name: string, option: string): Promise<string>`
  - `PtySession.start()` now disables the status line as part of the same tmux invocation

- [ ] **Step 1: Write the failing adapter tests**

Append to `tests/integration/adapter.test.ts`, inside the top-level scope alongside the other `describe` blocks:

```ts
describe('TmuxAdapter session options', () => {
  it('sets and reads back a session option', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await adapter.setSessionOption('prcli-lumio-a1b2c3d4e5f60718', 'status', 'off')
    await expect(adapter.getSessionOption('prcli-lumio-a1b2c3d4e5f60718', 'status'))
      .resolves.toBe('off')
  })

  it('targets exactly one session', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await createSession('prcli-lumio-00000000000000ff')
    await adapter.setSessionOption('prcli-lumio-a1b2c3d4e5f60718', 'status', 'off')
    await expect(adapter.getSessionOption('prcli-lumio-00000000000000ff', 'status'))
      .resolves.not.toBe('off')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/adapter.test.ts`
Expected: FAIL — `adapter.setSessionOption is not a function`.

- [ ] **Step 3: Implement the adapter methods**

In `src/main/tmux/adapter.ts`, add these two methods to `TmuxAdapter`, after `killSession`:

```ts
  /** `=name` keeps this on one session; without it tmux matches by prefix. */
  async setSessionOption(name: string, option: string, value: string): Promise<void> {
    await this.exec(['set-option', '-t', `=${name}`, option, value])
  }

  async getSessionOption(name: string, option: string): Promise<string> {
    return (await this.exec(['show-options', '-t', `=${name}`, '-v', option])).trim()
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/integration/adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing session test**

Append to `tests/integration/session.test.ts`, inside the existing `describe('PtySession', …)` block:

```ts
  it('disables tmux\'s own status line, which would collide with the app\'s tab bar', async () => {
    const session = open()
    await waitForOutput(session, /\$|%|#/)
    await expect(adapter.getSessionOption(NAME, 'status')).resolves.toBe('off')
    session.detach()
  })
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run tests/integration/session.test.ts`
Expected: FAIL — status is `on`.

- [ ] **Step 7: Chain the option onto session creation**

In `src/main/pty/session.ts`, inside `start()`, replace:

```ts
    if (this.options.command) args.push(this.options.command)
```

with:

```ts
    if (this.options.command) args.push(this.options.command)

    // Chained into the same invocation rather than issued afterwards: a
    // separate call would race the session actually existing. `;` is tmux's
    // own command separator and reaches it intact because node-pty spawns
    // without a shell.
    // The app draws its own chrome, so tmux's status line is redundant here.
    // A session attached from a plain terminal will also have it off.
    args.push(';', 'set-option', 'status', 'off')
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run tests/integration/session.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src/main/tmux/adapter.ts src/main/pty/session.ts tests/integration/adapter.test.ts tests/integration/session.test.ts
git commit -m "$(cat <<'EOF'
Turn off tmux's status line on app-managed sessions

The app draws its own tab bar in the same place. Chained onto the
new-session invocation so it cannot race the session existing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Config v2 — tab order and active tab

**Files:**
- Modify: `src/main/state/store.ts`
- Test: `tests/unit/store.test.ts`

**Interfaces:**
- Consumes: `TabRecord` from `src/main/sessions/manager.ts`
- Produces:
  - `interface PrcliConfig { version: 2; activeTabId: string | null; tabs: TabRecord[] }` — `tabs` order is display order
  - `ConfigStore.read()` migrates a v1 file to v2 in memory; it does not rewrite the file

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/store.test.ts`. Replace the existing `sampleConfig` declaration with:

```ts
const sampleConfig: PrcliConfig = {
  version: 2,
  activeTabId: 'a1b2c3d4e5f60718',
  tabs: [
    {
      id: 'a1b2c3d4e5f60718',
      projectSlug: 'lumio',
      cwd: '/Users/paolo/Code/Lumio',
      tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
    },
  ],
}
```

Update the two existing empty-config expectations — every `toEqual({ version: 1, tabs: [] })` becomes:

```ts
{ version: 2, activeTabId: null, tabs: [] }
```

Then add a new describe block:

```ts
describe('ConfigStore migration', () => {
  const v1 = {
    version: 1,
    tabs: [
      {
        id: 'a1b2c3d4e5f60718',
        projectSlug: 'lumio',
        cwd: '/Users/paolo/Code/Lumio',
        tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
      },
      {
        id: '00000000000000ff',
        projectSlug: 'lumio',
        cwd: '/Users/paolo/Code/Lumio',
        tmuxSession: 'prcli-lumio-00000000000000ff',
      },
    ],
  }

  it('reads a v1 file as v2, keeping tab order', async () => {
    await writeFile(file, JSON.stringify(v1), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.version).toBe(2)
    expect(config.tabs.map((tab) => tab.id)).toEqual(['a1b2c3d4e5f60718', '00000000000000ff'])
  })

  it('makes the first v1 tab active, since v1 had no concept of one', async () => {
    await writeFile(file, JSON.stringify(v1), 'utf8')
    await expect(new ConfigStore(file).read().then((c) => c.activeTabId))
      .resolves.toBe('a1b2c3d4e5f60718')
  })

  it('migrates an empty v1 file to a null active tab', async () => {
    await writeFile(file, JSON.stringify({ version: 1, tabs: [] }), 'utf8')
    await expect(new ConfigStore(file).read().then((c) => c.activeTabId)).resolves.toBeNull()
  })

  it('does not rewrite the file on read', async () => {
    await writeFile(file, JSON.stringify(v1), 'utf8')
    await new ConfigStore(file).read()
    const onDisk: unknown = JSON.parse(await readFile(file, 'utf8'))
    expect((onDisk as { version: number }).version).toBe(1)
  })

  it('rejects an unknown future version rather than guessing', async () => {
    await writeFile(file, JSON.stringify({ version: 99, tabs: [] }), 'utf8')
    await expect(new ConfigStore(file).read())
      .resolves.toEqual({ version: 2, activeTabId: null, tabs: [] })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/store.test.ts`
Expected: FAIL — `version` is 1, `activeTabId` undefined.

- [ ] **Step 3: Implement v2 and the migration**

In `src/main/state/store.ts`, replace the `PrcliConfig` interface, `EMPTY` and `isValid` with:

```ts
export interface PrcliConfig {
  version: 2
  /** Which tab the window should show on launch. */
  activeTabId: string | null
  /** Display order. */
  tabs: TabRecord[]
}

interface PrcliConfigV1 {
  version: 1
  tabs: TabRecord[]
}

const EMPTY: PrcliConfig = { version: 2, activeTabId: null, tabs: [] }

function hasTabs(value: unknown): value is { version: number; tabs: TabRecord[] } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { version?: unknown; tabs?: unknown }
  return typeof candidate.version === 'number' && Array.isArray(candidate.tabs)
}

/**
 * v1 had no active tab and no explicit ordering — array order was incidental.
 * Treating it as the order and making the first tab active is the closest
 * honest reading of an old file.
 */
function migrate(value: unknown): PrcliConfig {
  if (!hasTabs(value)) return { ...EMPTY }
  if (value.version === 2) {
    const v2 = value as Partial<PrcliConfig>
    return {
      version: 2,
      activeTabId: typeof v2.activeTabId === 'string' ? v2.activeTabId : null,
      tabs: value.tabs,
    }
  }
  if (value.version === 1) {
    const v1 = value as PrcliConfigV1
    return { version: 2, activeTabId: v1.tabs[0]?.id ?? null, tabs: v1.tabs }
  }
  // A version from the future: refuse to guess at its shape.
  return { ...EMPTY }
}
```

Then change `read()`'s body from the `isValid` check to:

```ts
  async read(): Promise<PrcliConfig> {
    try {
      return migrate(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch {
      return { ...EMPTY }
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the call sites**

`src/main/ipc/register.ts` constructs configs. Update every `{ version: 1, …}` literal it writes to `{ version: 2, activeTabId: <existing value>, … }`. Run the typechecker to find them all:

Run: `npm run typecheck`
Expected: errors naming each stale literal; fix each by carrying the previous `activeTabId` through unchanged. Where a function has no `activeTabId` in scope, read it from the config it just loaded.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/main/state/store.ts src/main/ipc/register.ts tests/unit/store.test.ts
git commit -m "$(cat <<'EOF'
Add tab order and active tab to the config

Config v2 records which tab was active and treats array order as display
order. A v1 file migrates in memory on read; the file is left alone until
something writes it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Restore from live tmux, not from config

Today config decides what exists, so a tmux session it does not know about is unreachable from the UI — the defect that stranded three real sessions. Invert it: tmux decides what exists, config supplies order and the active tab.

**Files:**
- Modify: `src/main/ipc/register.ts`, `src/shared/ipc.ts`
- Test: `tests/integration/restore.test.ts` (create)

**Interfaces:**
- Consumes: `SessionManager.findOrphans()`, `SessionManager.open()`, `ConfigStore`
- Produces:
  - `interface RestoreResult { tabs: TabDescriptor[]; activeTabId: string | null }`
  - `CHANNELS.restore` now resolves to `RestoreResult` rather than `TabDescriptor[]`
  - `CHANNELS.setActive` — `setActive(id: string | null): void`
  - `PrcliApi.restore(): Promise<RestoreResult>`, `PrcliApi.setActive(id: string | null): void`

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/restore.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { SessionManager } from '../../src/main/sessions/manager'
import { ConfigStore, type PrcliConfig } from '../../src/main/state/store'
import { restoreWorkspace } from '../../src/main/ipc/restore'

const run = promisify(execFile)
const SOCKET = 'prcli-test'

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

/** A prcli-shaped session created behind the app's back, as a crash would leave. */
async function createStray(name: string): Promise<void> {
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', name, 'sleep', '600'])
}

async function configWith(tabs: PrcliConfig['tabs'], activeTabId: string | null): Promise<ConfigStore> {
  const dir = await mkdtemp(join(tmpdir(), 'prcli-restore-'))
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ version: 2, activeTabId, tabs }), 'utf8')
  return new ConfigStore(file)
}

function tab(id: string, slug = 'lumio') {
  return {
    id,
    projectSlug: slug,
    cwd: tmpdir(),
    tmuxSession: `prcli-${slug}-${id}`,
  }
}

beforeAll(killServer)
afterEach(killServer)

describe('restoreWorkspace', () => {
  it('adopts a stray session that config has never heard of', async () => {
    await createStray('prcli-lumio-a1b2c3d4e5f60718')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith([], null)

    const result = await restoreWorkspace(manager, store)

    expect(result.tabs.map((t) => t.id)).toEqual(['a1b2c3d4e5f60718'])
    manager.detachAll()
  })

  it('drops a config row whose session no longer exists', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith([tab('00000000000000ff')], '00000000000000ff')

    const result = await restoreWorkspace(manager, store)

    expect(result.tabs).toEqual([])
    expect(result.activeTabId).toBeNull()
    await expect(store.read().then((c) => c.tabs)).resolves.toEqual([])
  })

  it('keeps config order and puts unknown strays after it', async () => {
    await createStray('prcli-lumio-1111111111111111')
    await createStray('prcli-lumio-2222222222222222')
    await createStray('prcli-lumio-3333333333333333')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    // Config knows 3 then 1, in that order, and not 2 at all.
    const store = await configWith(
      [tab('3333333333333333'), tab('1111111111111111')],
      '1111111111111111',
    )

    const result = await restoreWorkspace(manager, store)

    expect(result.tabs.map((t) => t.id)).toEqual([
      '3333333333333333',
      '1111111111111111',
      '2222222222222222',
    ])
    manager.detachAll()
  })

  it('preserves the saved active tab when its session survived', async () => {
    await createStray('prcli-lumio-1111111111111111')
    await createStray('prcli-lumio-2222222222222222')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith(
      [tab('1111111111111111'), tab('2222222222222222')],
      '2222222222222222',
    )

    await expect(restoreWorkspace(manager, store).then((r) => r.activeTabId))
      .resolves.toBe('2222222222222222')
    manager.detachAll()
  })

  it('falls back to the first tab when the saved active tab died', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith(
      [tab('1111111111111111'), tab('2222222222222222')],
      '2222222222222222',
    )

    await expect(restoreWorkspace(manager, store).then((r) => r.activeTabId))
      .resolves.toBe('1111111111111111')
    manager.detachAll()
  })

  it('writes the reconciled workspace back to config', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith([], null)

    await restoreWorkspace(manager, store)

    const saved = await store.read()
    expect(saved.tabs.map((t) => t.id)).toEqual(['1111111111111111'])
    expect(saved.activeTabId).toBe('1111111111111111')
    manager.detachAll()
  })

  it('returns an empty workspace when tmux has nothing of ours', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith([], null)
    await expect(restoreWorkspace(manager, store)).resolves.toEqual({ tabs: [], activeTabId: null })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/restore.test.ts`
Expected: FAIL — cannot resolve `../../src/main/ipc/restore`.

- [ ] **Step 3: Implement restore as its own module**

Create `src/main/ipc/restore.ts`:

```ts
import type { SessionManager, TabRecord } from '../sessions/manager'
import type { ConfigStore } from '../state/store'
// One definition, shared with the renderer — `TabDescriptor` and `TabRecord`
// are the same shape, and duplicating the type here would let them drift.
import type { RestoreResult } from '../../shared/ipc'

/**
 * Reconcile the saved workspace against what tmux actually has.
 *
 * Live tmux sessions decide what exists; config only supplies display order
 * and which tab was active. Deriving existence from config instead is what
 * made a session the app had lost track of unreachable from the UI — and a
 * crash, an external `tmux kill-session`, or a second instance can all leave
 * one behind.
 */
export async function restoreWorkspace(
  manager: SessionManager,
  store: ConfigStore,
): Promise<RestoreResult> {
  const saved = await store.read()
  const orphans = await manager.findOrphans()
  const byId = new Map(orphans.map((orphan) => [orphan.id, orphan]))

  // Saved order first, skipping rows whose session is gone.
  const ordered: TabRecord[] = []
  for (const row of saved.tabs) {
    const orphan = byId.get(row.id)
    if (!orphan) continue
    byId.delete(row.id)
    // The saved row carries the real cwd; the orphan's is synthesised.
    ordered.push({ ...orphan, cwd: row.cwd, command: row.command })
  }
  // Then anything tmux has that config did not know about.
  ordered.push(...byId.values())

  const tabs = ordered.map((record) =>
    manager.open({
      id: record.id,
      projectSlug: record.projectSlug,
      cwd: record.cwd,
      command: record.command,
      tmuxSession: record.tmuxSession,
    }),
  )

  const activeTabId =
    tabs.find((candidate) => candidate.id === saved.activeTabId)?.id ?? tabs[0]?.id ?? null

  await store.write({ version: 2, activeTabId, tabs })
  return { tabs, activeTabId }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/integration/restore.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire it into IPC and add `setActive`**

In `src/shared/ipc.ts`, add `setActive: 'prcli:setActive'` to `CHANNELS`, then add:

```ts
export interface RestoreResult {
  tabs: TabDescriptor[]
  activeTabId: string | null
}
```

and change `PrcliApi`'s restore signature, plus add `setActive`:

```ts
  restore(): Promise<RestoreResult>
  setActive(id: string | null): void
```

In `src/main/ipc/register.ts`, replace the whole `CHANNELS.restore` handler with:

```ts
  ipcMain.handle(CHANNELS.restore, (): Promise<RestoreResult> => restoreWorkspace(manager, store))

  ipcMain.on(CHANNELS.setActive, (_event, id: string | null) => {
    void serialise(async () => {
      const config = await store.read()
      await store.write({ ...config, activeTabId: id })
    })
  })
```

adding `import { restoreWorkspace } from './restore'` and `import type { RestoreResult } from '../../shared/ipc'` at the top.

In `src/preload/index.ts`, add to the api object:

```ts
  setActive: (id: string | null) => ipcRenderer.send(CHANNELS.setActive, id),
```

- [ ] **Step 6: Verify the whole thing typechecks**

`restoreWorkspace` passes `tmuxSession` to `manager.open`. `OpenInput.tmuxSession` already exists and already throws when the saved name disagrees with what the input encodes to, so nothing further is needed there — do not add a second check.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Run the full suite**

Run: `npm test && npm run typecheck && npm run e2e`
Expected: all green. The M1 E2E reattach tests must still pass — they exercise this path.

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc/restore.ts src/main/ipc/register.ts src/shared/ipc.ts src/preload/index.ts tests/integration/restore.test.ts
git commit -m "$(cat <<'EOF'
Restore the workspace from live tmux rather than from config

Config decided what existed, so any session it had lost track of was
unreachable from the UI — a crash or a second instance could strand one
permanently. tmux now decides what exists; config supplies display order
and the active tab, and rows whose session is gone prune themselves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Tabs reducer

Pure state transitions, no React and no I/O, so the tab rules are testable without a DOM.

**Files:**
- Create: `src/renderer/tabs.ts`
- Test: `tests/unit/tabs.test.ts`

**Interfaces:**
- Consumes: `TabDescriptor` from `src/shared/ipc.ts`
- Produces:
  - `interface TabsState { tabs: TabDescriptor[]; activeId: string | null }`
  - `type TabsAction` — `{type:'restored', tabs, activeId}` | `{type:'opened', tab}` | `{type:'removed', id}` | `{type:'activated', id}`
  - `const INITIAL_TABS_STATE: TabsState`
  - `function tabsReducer(state: TabsState, action: TabsAction): TabsState`
  - `function neighbourOf(tabs: TabDescriptor[], id: string): string | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/tabs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  INITIAL_TABS_STATE,
  tabsReducer,
  neighbourOf,
  type TabsState,
} from '../../src/renderer/tabs'
import type { TabDescriptor } from '../../src/shared/ipc'

function tab(id: string): TabDescriptor {
  return {
    id,
    projectSlug: 'lumio',
    cwd: '/Users/paolo/Code/Lumio',
    tmuxSession: `prcli-lumio-${id}`,
  }
}

const three: TabsState = {
  tabs: [tab('aaa'), tab('bbb'), tab('ccc')],
  activeId: 'bbb',
}

describe('neighbourOf', () => {
  it('prefers the tab to the right', () => {
    expect(neighbourOf(three.tabs, 'aaa')).toBe('bbb')
  })

  it('falls back to the left for the last tab', () => {
    expect(neighbourOf(three.tabs, 'ccc')).toBe('bbb')
  })

  it('returns null when it was the only tab', () => {
    expect(neighbourOf([tab('aaa')], 'aaa')).toBeNull()
  })

  it('returns null for an unknown id', () => {
    expect(neighbourOf(three.tabs, 'zzz')).toBeNull()
  })
})

describe('tabsReducer', () => {
  it('starts empty', () => {
    expect(INITIAL_TABS_STATE).toEqual({ tabs: [], activeId: null })
  })

  it('replaces everything on restore', () => {
    const next = tabsReducer(three, { type: 'restored', tabs: [tab('zzz')], activeId: 'zzz' })
    expect(next).toEqual({ tabs: [tab('zzz')], activeId: 'zzz' })
  })

  it('appends an opened tab and activates it', () => {
    const next = tabsReducer(three, { type: 'opened', tab: tab('ddd') })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'bbb', 'ccc', 'ddd'])
    expect(next.activeId).toBe('ddd')
  })

  it('ignores an opened tab that is already present', () => {
    const next = tabsReducer(three, { type: 'opened', tab: tab('bbb') })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('activates a tab', () => {
    expect(tabsReducer(three, { type: 'activated', id: 'ccc' }).activeId).toBe('ccc')
  })

  it('ignores activation of an unknown tab', () => {
    expect(tabsReducer(three, { type: 'activated', id: 'zzz' }).activeId).toBe('bbb')
  })

  it('removes a tab and moves the active one to its neighbour', () => {
    const next = tabsReducer(three, { type: 'removed', id: 'bbb' })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'ccc'])
    expect(next.activeId).toBe('ccc')
  })

  it('leaves the active tab alone when removing a different one', () => {
    const next = tabsReducer(three, { type: 'removed', id: 'aaa' })
    expect(next.activeId).toBe('bbb')
  })

  it('goes back to nothing active when the last tab is removed', () => {
    const one: TabsState = { tabs: [tab('aaa')], activeId: 'aaa' }
    expect(tabsReducer(one, { type: 'removed', id: 'aaa' })).toEqual({ tabs: [], activeId: null })
  })

  it('ignores removal of an unknown tab', () => {
    expect(tabsReducer(three, { type: 'removed', id: 'zzz' })).toEqual(three)
  })

  it('never mutates the state it is given', () => {
    const before = JSON.stringify(three)
    tabsReducer(three, { type: 'removed', id: 'bbb' })
    tabsReducer(three, { type: 'opened', tab: tab('ddd') })
    expect(JSON.stringify(three)).toBe(before)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/tabs.test.ts`
Expected: FAIL — cannot resolve `../../src/renderer/tabs`.

- [ ] **Step 3: Implement**

Create `src/renderer/tabs.ts`:

```ts
import type { TabDescriptor } from '../shared/ipc'

export interface TabsState {
  tabs: TabDescriptor[]
  activeId: string | null
}

export type TabsAction =
  | { type: 'restored'; tabs: TabDescriptor[]; activeId: string | null }
  | { type: 'opened'; tab: TabDescriptor }
  | { type: 'removed'; id: string }
  | { type: 'activated'; id: string }

export const INITIAL_TABS_STATE: TabsState = { tabs: [], activeId: null }

/**
 * Which tab to show once `id` goes away: the one to its right, or its left
 * when it was last. Null when it was the only one.
 */
export function neighbourOf(tabs: TabDescriptor[], id: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return null
  const next = tabs[index + 1] ?? tabs[index - 1]
  return next?.id ?? null
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'restored':
      return { tabs: action.tabs, activeId: action.activeId }

    case 'opened': {
      if (state.tabs.some((tab) => tab.id === action.tab.id)) return state
      return { tabs: [...state.tabs, action.tab], activeId: action.tab.id }
    }

    case 'activated': {
      if (!state.tabs.some((tab) => tab.id === action.id)) return state
      return { ...state, activeId: action.id }
    }

    case 'removed': {
      if (!state.tabs.some((tab) => tab.id === action.id)) return state
      const activeId =
        state.activeId === action.id ? neighbourOf(state.tabs, action.id) : state.activeId
      return { tabs: state.tabs.filter((tab) => tab.id !== action.id), activeId }
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/tabs.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tabs.ts tests/unit/tabs.test.ts
git commit -m "$(cat <<'EOF'
Add the tabs reducer

Pure state transitions with no React and no I/O, so the rules about what
becomes active when a tab closes are testable without a DOM.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Tab bar

**Files:**
- Create: `src/renderer/TabBar.tsx`
- Modify: `src/renderer/Terminal.tsx`

**Interfaces:**
- Consumes: `TabDescriptor`, `TabsState`
- Produces:
  - `function TabBar(props: { tabs: TabDescriptor[]; activeId: string | null; onActivate(id: string): void; onClose(id: string): void; onNew(): void }): JSX.Element`
  - `Terminal` gains a `visible: boolean` prop

- [ ] **Step 1: Implement the tab bar**

Create `src/renderer/TabBar.tsx`:

```tsx
import type { CSSProperties } from 'react'
import type { TabDescriptor } from '../shared/ipc'

const BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  height: 32,
  background: '#0c0c0e',
  borderBottom: '1px solid #27272a',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  userSelect: 'none',
  overflowX: 'auto',
}

function tabStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 10px',
    borderRight: '1px solid #27272a',
    color: active ? '#fafafa' : '#71717a',
    background: active ? '#09090b' : 'transparent',
    boxShadow: active ? 'inset 0 -1px 0 #a3e635' : undefined,
    whiteSpace: 'nowrap',
    cursor: 'default',
  }
}

/** The tmux id is 16 hex characters; the first six are plenty to tell tabs apart. */
function label(tab: TabDescriptor): string {
  return `${tab.projectSlug} · ${tab.id.slice(0, 6)}`
}

export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew,
}: {
  tabs: TabDescriptor[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}) {
  return (
    <div style={BAR} data-testid="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-testid={`tab-${tab.id}`}
          data-active={tab.id === activeId ? 'true' : 'false'}
          style={tabStyle(tab.id === activeId)}
          onClick={() => onActivate(tab.id)}
        >
          <span>{label(tab)}</span>
          <button
            data-testid={`close-${tab.id}`}
            aria-label={`Close ${label(tab)}`}
            onClick={(event) => {
              // Without this the click also activates the tab being closed.
              event.stopPropagation()
              onClose(tab.id)
            }}
            style={{
              background: 'none',
              border: 'none',
              color: 'inherit',
              cursor: 'default',
              fontSize: 12,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        data-testid="new-tab"
        aria-label="New terminal"
        onClick={onNew}
        style={{
          background: 'none',
          border: 'none',
          color: '#3f3f46',
          cursor: 'default',
          fontSize: 14,
          padding: '0 12px',
        }}
      >
        +
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Make Terminal aware of being hidden**

A hidden element measures as zero, so fitting it would send a garbage size to the PTY and reflow the real session. In `src/renderer/Terminal.tsx`, change the component signature from:

```tsx
export function Terminal({ tabId }: { tabId: string }) {
```

to:

```tsx
export function Terminal({ tabId, visible }: { tabId: string; visible: boolean }) {
```

Then replace the initial fit and the `ResizeObserver` block with:

```tsx
    const fitToContainer = (): void => {
      // A hidden container measures 0×0; fitting to that would resize the
      // real tmux session down to nothing.
      if (container.offsetParent === null) return
      fit.fit()
      window.prcli.resize(tabId, term.cols, term.rows)
    }

    fitToContainer()

    const observer = new ResizeObserver(fitToContainer)
    observer.observe(container)
```

and add a second effect after the existing one, so a tab refits when it becomes visible:

```tsx
  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      fitRef.current?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])
```

To make that possible, hold the fit function in a ref. Add near the top of the component:

```tsx
  const fitRef = useRef<(() => void) | null>(null)
```

and inside the first effect, immediately after defining `fitToContainer`:

```tsx
    fitRef.current = fitToContainer
```

and in that effect's cleanup, add:

```tsx
      fitRef.current = null
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: errors only where `App.tsx` still renders `<Terminal tabId=… />` without `visible`. Task 7 fixes that; if you want a clean checkpoint now, pass `visible` from `App.tsx` as part of Task 7 and commit both together.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/TabBar.tsx src/renderer/Terminal.tsx
git commit -m "$(cat <<'EOF'
Add the tab bar and teach Terminal about being hidden

A hidden container measures zero, and fitting to that would resize the
real tmux session down to nothing — so hidden terminals skip fitting and
refit when they become visible.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Multi-tab App

**Files:**
- Rewrite: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `tabsReducer`, `INITIAL_TABS_STATE`, `TabBar`, `Terminal`, `window.prcli`
- Produces: the working multi-tab window

- [ ] **Step 1: Rewrite App.tsx**

Replace `src/renderer/App.tsx` entirely:

```tsx
import { useCallback, useEffect, useReducer, useState } from 'react'
import { Terminal } from './Terminal'
import { TabBar } from './TabBar'
import { INITIAL_TABS_STATE, tabsReducer } from './tabs'

// Milestone 2b replaces this with real projects.
const SCRATCH_PROJECT = { projectSlug: 'scratch', cwd: '/Users/paolo/Code' }

export function App() {
  const [state, dispatch] = useReducer(tabsReducer, INITIAL_TABS_STATE)
  const [error, setError] = useState<string | null>(null)

  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason))
  }, [])

  const openTab = useCallback(() => {
    window.prcli
      .open(SCRATCH_PROJECT)
      .then((tab) => {
        dispatch({ type: 'opened', tab })
        window.prcli.setActive(tab.id)
      })
      .catch(fail)
  }, [fail])

  const activateTab = useCallback((id: string) => {
    dispatch({ type: 'activated', id })
    window.prcli.setActive(id)
  }, [])

  // Closing a tab destroys its session. Detaching instead would leave a
  // session running that the UI no longer lists — which is how sessions got
  // stranded before.
  const closeTab = useCallback(
    (id: string) => {
      window.prcli
        .kill(id)
        .then(() => dispatch({ type: 'removed', id }))
        .catch(fail)
    },
    [fail],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { tabs, activeTabId } = await window.prcli.restore()
      if (cancelled) return
      if (tabs.length > 0) {
        dispatch({ type: 'restored', tabs, activeId: activeTabId })
        return
      }
      const tab = await window.prcli.open(SCRATCH_PROJECT)
      if (cancelled) return
      dispatch({ type: 'opened', tab })
      window.prcli.setActive(tab.id)
    })().catch((reason: unknown) => {
      if (!cancelled) fail(reason)
    })
    return () => {
      cancelled = true
    }
  }, [fail])

  // A session that dies on its own must leave the tab bar with it.
  useEffect(() => window.prcli.onExit(({ id }) => dispatch({ type: 'removed', id })), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey) return
      if (event.key === 't') {
        event.preventDefault()
        openTab()
        return
      }
      if (event.key === 'w' && state.activeId) {
        event.preventDefault()
        closeTab(state.activeId)
        return
      }
      const digit = Number.parseInt(event.key, 10)
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const target = state.tabs[digit - 1]
        if (target) {
          event.preventDefault()
          activateTab(target.id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state.activeId, state.tabs, openTab, closeTab, activateTab])

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: '#09090b',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <TabBar
        tabs={state.tabs}
        activeId={state.activeId}
        onActivate={activateTab}
        onClose={closeTab}
        onNew={openTab}
      />
      {error ? (
        <pre
          data-testid="startup-error"
          style={{
            color: '#f87171',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            padding: 8,
            margin: 0,
          }}
        >
          {error}
        </pre>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {/* Every terminal stays mounted. Unmounting would dispose its xterm
            and lose local scrollback and viewport position on every switch. */}
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            data-testid={tab.id === state.activeId ? 'terminal-active' : `terminal-${tab.id}`}
            style={{
              position: 'absolute',
              inset: 0,
              padding: 8,
              display: tab.id === state.activeId ? 'block' : 'none',
            }}
          >
            <Terminal tabId={tab.id} visible={tab.id === state.activeId} />
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles and the suite still passes**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 3: Check it by hand**

Run: `npm start`

Confirm: a tab bar appears with one tab; `+` opens a second; clicking switches between them and each keeps its own scrollback; ⌘T opens a tab; ⌘1 and ⌘2 switch; the `×` closes a tab and the neighbour becomes active; closing the last tab leaves an empty window with a working `+`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "$(cat <<'EOF'
Render every tab, switchable from the tab bar

Terminals all stay mounted and hide with display:none — unmounting would
dispose the xterm and lose scrollback on every switch. Closing a tab kills
its session rather than detaching, so the UI never leaves one stranded.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: End-to-end coverage

**Files:**
- Modify: `tests/e2e/tabs.spec.ts`

**Interfaces:**
- Consumes: everything above

- [ ] **Step 1: Add the tests**

Append to `tests/e2e/tabs.spec.ts`:

```ts
test('opens several tabs and keeps each one\'s scrollback', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('terminal-active')).toBeVisible()

  await window.getByTestId('terminal-active').click()
  await window.keyboard.type('echo first-tab')
  await window.keyboard.press('Enter')
  await expect(window.locator('.xterm-rows')).toContainText('first-tab', { timeout: 20_000 })

  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)

  await window.getByTestId('terminal-active').click()
  await window.keyboard.type('echo second-tab')
  await window.keyboard.press('Enter')
  await expect(window.getByTestId('terminal-active')).toContainText('second-tab', {
    timeout: 20_000,
  })
  // The first tab's content is hidden, not gone.
  await expect(window.getByTestId('terminal-active')).not.toContainText('first-tab')

  const tabs = window.locator('[data-testid^="tab-"]')
  await expect(tabs).toHaveCount(2)
  await tabs.first().click()
  await expect(window.getByTestId('terminal-active')).toContainText('first-tab', {
    timeout: 20_000,
  })

  await app.close()
})

test('restores every tab and the active one after a relaunch', async () => {
  const first = await launch()
  const firstWindow = await first.firstWindow()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible()
  await firstWindow.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)

  await firstWindow.getByTestId('terminal-active').click()
  await firstWindow.keyboard.type('echo marker-two')
  await firstWindow.keyboard.press('Enter')
  await expect(firstWindow.getByTestId('terminal-active')).toContainText('marker-two', {
    timeout: 20_000,
  })
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.locator('[data-testid^="tab-"]')).toHaveCount(2)
  // The second tab was active when we quit, and its scrollback came back.
  await expect(secondWindow.getByTestId('terminal-active')).toContainText('marker-two', {
    timeout: 20_000,
  })
  await second.close()
})

test('adopts a session the app has never seen', async () => {
  // Exactly what a crash or an external tmux command leaves behind.
  await run('tmux', [
    '-L', SOCKET, 'new-session', '-d', '-s', 'prcli-scratch-abcdef0123456789', 'sleep', '600',
  ])

  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect(window.getByTestId('tab-abcdef0123456789')).toBeVisible()

  await app.close()
})

test('closing a tab destroys its session', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)

  const closeButtons = window.locator('[data-testid^="close-"]')
  await closeButtons.first().click()

  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(1)

  await app.close()
})
```

- [ ] **Step 2: Run them**

Run: `npm run e2e -- tests/e2e/tabs.spec.ts`
Expected: PASS, 5 tests.

If the adoption test fails because the stray session's name does not decode, check it against `decodeSessionName` — the slug must match `^[a-z0-9_]+$` and the id `^[0-9a-f]{16}$`.

- [ ] **Step 3: Run everything**

Run: `npm test && npm run typecheck && npm run e2e`
Expected: all green.

- [ ] **Step 4: Verify nothing leaked**

Run: `tmux ls` and `ls ~/.prcli`
Expected: no `prcli-*` sessions on the default socket; `~/.prcli` untouched by the test run.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/tabs.spec.ts
git commit -m "$(cat <<'EOF'
Cover multi-tab behaviour end to end

Several tabs each keeping their own scrollback, restore of both the tab
set and the active tab, adoption of a session the app never opened, and
close destroying its session.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Milestone 2a done when

- The tab bar shows every open terminal; `+`, ⌘T, ⌘W and ⌘1–9 all work
- Each tab keeps its own scrollback across switches
- Quitting and relaunching restores every tab and the one that was active
- A tmux session the app never opened is adopted into the tab bar on launch
- Launching a second instance focuses the first window instead of opening more sessions
- tmux's own status line is gone from app-managed sessions
- `npm test`, `npm run typecheck` and `npm run e2e` are green, and no `prcli-*` session is left on the default socket

## Deliberately not in this milestone

Projects, the sidebar, per-project presets and the add-project picker (Milestone 2b). Splits (Milestone 2c). The "Needs you" list, session state, hooks, notifications and the dock badge — all of which need Milestone 3's hook bridge before they can show anything real.

Also left for later, with reasons:

- **Tab reordering by drag.** Config already stores order; nothing yet changes it from the UI.
- **A confirmation before closing a busy tab.** ⌘W kills the session outright. Detecting whether real work is running needs `#{pane_current_command}`, and the honest version of the question ("is Claude mid-turn?") is Milestone 3's hook state, not a string comparison.
- **Renaming tabs.** Labels are `slug · id-prefix` until projects give them something better to say in 2b.
