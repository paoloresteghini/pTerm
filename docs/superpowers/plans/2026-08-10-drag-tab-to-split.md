# Drag tab onto tab to split: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dragging one tab onto another merges the two into a split tab, keeping
both shells, both running processes and both scrollbacks alive.

**Architecture:** The dragged pane's tmux window is moved into the target pane's
session group with `move-window`, its now-redundant session is killed, and a
session of the same name is recreated inside the target group. The shell is
never restarted, only re-parented. Main then rewrites two tab rows (the target
gains a kid, the source loses one or is dropped) and the renderer folds both
into state through a new reducer action.

**Tech Stack:** Electron, TypeScript, React, tmux via `TmuxAdapter`, vitest for
unit and integration, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-08-10-drag-tab-to-split-design.md`. Read
it before Task 1. It records the tmux behaviour that was measured rather than
assumed, and one step whose omission causes delayed data loss.

## Global Constraints

- **No em dashes anywhere.** Not in code, comments, copy, test names or commit
  messages. Use commas, colons, parentheses or separate sentences.
- **Never kill a shell.** No step in this feature may terminate a user process.
  `kill-session` is only ever called on a session whose window has already been
  moved away from it. If you find yourself reaching for `manager.kill()`, stop:
  that is approach B, which the spec rejects.
- **Comments: write your own.** This plan deliberately does not dictate comment
  prose. Where a comment is warranted, read the surrounding code and write what
  is actually true of the code you wrote. A transcribed comment that no longer
  matches its code is worse than no comment.
- **`selectWindow` takes an INDEX, not a window id** (`adapter.ts:292`). Window
  indices change when a window moves between sessions, so any snapshot must be
  taken as window **ids** and resolved back to indices after the move.
- **tmux target syntax:** `=name` is exact match, a trailing colon makes it a
  window target on that session's current window, and a window id (`@7`) is
  already exact and takes neither.
- **Integration tests must leave a holder session alive** on the test socket.
  The shared `pterm-test` server exits when its last session dies, and that has
  produced flaky runs in this repo before.
- Run `npm run typecheck` before every commit. Unit and integration: `npm test`.
  E2E: `npm run e2e`.

---

## File Structure

**Created:**
- `tests/integration/join.test.ts` - the pid-preservation and group-shape tests
- `tests/e2e/dragSplit.spec.ts` - the drag-and-drop specs

**Modified:**
- `src/main/tmux/adapter.ts` - two new tmux commands
- `src/main/sessions/manager.ts` - `joinTab`, the whole tmux sequence
- `src/shared/ipc.ts` - `JoinShape`, `CHANNELS.joinPane`, bridge signature
- `src/main/preload.ts` - bridge wiring
- `src/main/ipc/register.ts` - the `joinPane` handler, rewriting two rows
- `src/renderer/workspace.ts` - `joined` action and `applyJoinShape`
- `src/renderer/TabsPanel.tsx` - rows become drag sources and drop targets
- `src/renderer/TabBar.tsx` - same, for the horizontal bar
- `src/renderer/App.tsx` - the join callback and the refusal rules
- `tests/integration/adapter.test.ts` - adapter-level tests
- `tests/unit/workspace.test.ts` - reducer tests

---

### Task 1: Two new tmux adapter commands

**Files:**
- Modify: `src/main/tmux/adapter.ts`
- Test: `tests/integration/adapter.test.ts`

**Interfaces:**
- Produces:
  - `TmuxAdapter.moveWindow(sourceSession: string, targetSession: string): Promise<void>`
  - `TmuxAdapter.windowsOf(session: string): Promise<{ index: string; id: string }[]>`

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/adapter.test.ts`, following the existing socket and
`killServer` conventions already in that file:

```ts
it('moves a session current window into another session, keeping the process', async () => {
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'holder'])
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'src'])
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'dst'])
  const before = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', '=src:', '#{pane_pid}',
  ])

  await adapter.moveWindow('src', 'dst')

  const windows = await adapter.windowsOf('dst')
  const pids = await Promise.all(
    windows.map(async (window) =>
      (await run('tmux', [
        '-L', SOCKET, 'display-message', '-p', '-t', window.id, '#{pane_pid}',
      ])).stdout.trim(),
    ),
  )
  expect(windows).toHaveLength(2)
  expect(pids).toContain(before.stdout.trim())
  expect(await adapter.hasSession('src')).toBe(false)
})

it('reports window indices and ids together', async () => {
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'holder'])
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'solo'])

  const windows = await adapter.windowsOf('solo')

  expect(windows).toHaveLength(1)
  expect(windows[0].index).toMatch(/^\d+$/)
  expect(windows[0].id).toMatch(/^@\d+$/)
})

it('answers with no windows for a session tmux does not have', async () => {
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'holder'])

  expect(await adapter.windowsOf('nosuchsession')).toEqual([])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/adapter.test.ts -t 'moves a session current window'`
Expected: FAIL, `adapter.moveWindow is not a function`.

- [ ] **Step 3: Implement both methods**

Add to `src/main/tmux/adapter.ts`, near `selectWindow`:

```ts
  async moveWindow(sourceSession: string, targetSession: string): Promise<void> {
    await this.exec(['move-window', '-s', `=${sourceSession}:`, '-t', `=${targetSession}:`])
  }

  async windowsOf(session: string): Promise<{ index: string; id: string }[]> {
    try {
      const stdout = await this.exec([
        'list-windows', '-t', `=${session}`, '-F', '#{window_index}\t#{window_id}',
      ])
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [index, id = ''] = line.split('\t')
          return { index, id }
        })
    } catch (error) {
      if (error instanceof TmuxNotInstalledError) throw error
      if (isNoSuchSession(error)) return []
      throw error
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/adapter.test.ts`
Expected: PASS, including the file's pre-existing tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/main/tmux/adapter.ts tests/integration/adapter.test.ts
git commit -m "Add moveWindow and windowsOf to the tmux adapter"
```

---

### Task 2: `SessionManager.joinTab`, the tmux sequence

This is the task the whole feature rests on. Read the spec sections "The tmux
mechanism, as measured" and "The step that is load-bearing" before starting.

**Files:**
- Modify: `src/main/sessions/manager.ts`
- Test: `tests/integration/join.test.ts` (create)

**Interfaces:**
- Consumes: `TmuxAdapter.moveWindow`, `TmuxAdapter.windowsOf` (Task 1);
  existing `groupNameOf(paneId)`, `listSessionsWithGroups()`,
  `windowIdOf(name)`, `killSession(name)`, `newGroupMember(group, name, env)`,
  `selectWindow(name, index)`, `hasSession(name)`, `tabIdOf(paneId)`,
  `detach(id)`, `open(input)`.
- Produces:
  `SessionManager.joinTab(input: { paneId: string; targetPaneId: string }): Promise<{ record: TerminalPaneRecord; tabId: string }>`
  where `tabId` is the TARGET tab's id and `record` is the moved pane, freshly
  attached inside it.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/join.test.ts`. Copy the socket setup, `killServer`
and cleanup conventions from `tests/integration/manager.test.ts`, and keep a
`holder` session alive for the whole file.

```ts
/** The pid of the process running in whatever window this session is showing. */
async function panePid(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{pane_pid}',
  ])
  return stdout.trim()
}

/** The window id each named session is currently showing. */
async function shownWindows(names: string[]): Promise<string[]> {
  return Promise.all(
    names.map(async (name) => {
      const { stdout } = await run('tmux', [
        '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_id}',
      ])
      return stdout.trim()
    }),
  )
}

it('keeps the moved pane process alive when two standalone tabs merge', async () => {
  const target = manager.open({ id: 'aaa', projectSlug: 'demo', cwd })
  const moved = manager.open({ id: 'bbb', projectSlug: 'demo', cwd })
  await settle()
  const before = await panePid(moved.tmuxSession)

  const joined = await manager.joinTab({ paneId: 'bbb', targetPaneId: 'aaa' })

  expect(await panePid(joined.record.tmuxSession)).toBe(before)
  expect(joined.tabId).toBe('aaa')
  expect(await panePid(target.tmuxSession)).not.toBe(before)
})

it('puts both panes in one tmux group', async () => {
  manager.open({ id: 'aaa', projectSlug: 'demo', cwd })
  manager.open({ id: 'bbb', projectSlug: 'demo', cwd })
  await settle()

  await manager.joinTab({ paneId: 'bbb', targetPaneId: 'aaa' })

  const rows = await adapter.listSessionsWithGroups()
  const groups = ['aaa', 'bbb'].map(
    (id) => rows.find((row) => row.name === encodeSessionName({ projectSlug: 'demo', id }))?.group,
  )
  expect(groups[0]).toBeTruthy()
  expect(groups[1]).toBe(groups[0])
})

it('leaves every member of the target group on a window of its own', async () => {
  manager.open({ id: 'aaa', projectSlug: 'demo', cwd })
  await settle()
  await manager.splitTab({ paneId: 'aaa', cols: 80, rows: 24 })
  manager.open({ id: 'ccc', projectSlug: 'demo', cwd })
  await settle()

  await manager.joinTab({ paneId: 'ccc', targetPaneId: 'aaa' })

  const names = (await adapter.listSessionsWithGroups())
    .filter((row) => row.group && row.name.includes('demo'))
    .map((row) => row.name)
  const shown = await shownWindows(names)
  expect(new Set(shown).size).toBe(shown.length)
})

it('keeps both processes alive when a pane moves between two splits', async () => {
  manager.open({ id: 'aaa', projectSlug: 'demo', cwd })
  manager.open({ id: 'ccc', projectSlug: 'demo', cwd })
  await settle()
  const second = await manager.splitTab({ paneId: 'aaa', cols: 80, rows: 24 })
  await manager.splitTab({ paneId: 'ccc', cols: 80, rows: 24 })
  const before = await panePid(second.tmuxSession)

  const joined = await manager.joinTab({ paneId: second.id, targetPaneId: 'ccc' })

  expect(await panePid(joined.record.tmuxSession)).toBe(before)
  expect(joined.tabId).toBe('ccc')
})

it('leaves the survivor of a founder move alive and on its own window', async () => {
  manager.open({ id: 'aaa', projectSlug: 'demo', cwd })
  manager.open({ id: 'ccc', projectSlug: 'demo', cwd })
  await settle()
  const survivor = await manager.splitTab({ paneId: 'aaa', cols: 80, rows: 24 })
  const survivorPid = await panePid(survivor.tmuxSession)

  await manager.joinTab({ paneId: 'aaa', targetPaneId: 'ccc' })

  expect(await panePid(survivor.tmuxSession)).toBe(survivorPid)
})

it('refuses to join a pane to its own tab', async () => {
  manager.open({ id: 'aaa', projectSlug: 'demo', cwd })
  await settle()
  const sibling = await manager.splitTab({ paneId: 'aaa', cols: 80, rows: 24 })

  await expect(manager.joinTab({ paneId: sibling.id, targetPaneId: 'aaa' })).rejects.toThrow(
    /already/i,
  )
})
```

`settle()` is whatever short wait the neighbouring integration tests already use
after `manager.open` before asking tmux about a session. Reuse that helper
rather than inventing a new sleep.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/join.test.ts`
Expected: FAIL, `manager.joinTab is not a function`.

- [ ] **Step 3: Implement `joinTab`**

Add to `src/main/sessions/manager.ts`, near `splitTab`:

```ts
  async joinTab(input: {
    paneId: string
    targetPaneId: string
  }): Promise<{ record: TerminalPaneRecord; tabId: string }> {
    const moving = this.entries.get(input.paneId)
    const target = this.entries.get(input.targetPaneId)
    if (!moving) throw new Error(`joinTab: no pane ${input.paneId}`)
    if (!target) throw new Error(`joinTab: no pane ${input.targetPaneId}`)
    if (moving.tabId === target.tabId) {
      throw new Error(`joinTab: pane ${input.paneId} is already in that tab`)
    }

    const targetTabId = target.tabId
    const group = await this.groupNameOf(input.targetPaneId)
    const record = moving.record
    const { cols, rows } = moving

    const movedWindow = await this.adapter.windowIdOf(record.tmuxSession)
    if (!movedWindow) throw new Error(`joinTab: tmux would not name ${record.tmuxSession}'s window`)

    // Create the destination BEFORE anything moves. See the ordering note below.
    const staging = `${record.tmuxSession}-joining`
    await this.adapter.newGroupMember(group, staging, { PTERM_TAB_ID: record.id })

    this.detach(input.paneId)
    try {
      await this.adapter.moveWindow(record.tmuxSession, staging)
      if (await this.adapter.hasSession(record.tmuxSession)) {
        await this.adapter.killSession(record.tmuxSession)
      }
      await this.adapter.renameSession(staging, record.tmuxSession)
    } catch (error) {
      await this.adapter.killSession(staging).catch(() => undefined)
      throw error
    }

    const windows = await this.adapter.windowsOf(record.tmuxSession)
    const indexOf = new Map(windows.map((window) => [window.id, window.index]))
    const movedIndex = indexOf.get(movedWindow)
    if (!movedIndex) throw new Error(`joinTab: ${movedWindow} is not in ${group} after the move`)
    await this.adapter.selectWindow(record.tmuxSession, movedIndex)

    return {
      record: this.open({
        id: record.id,
        projectSlug: record.projectSlug,
        cwd: record.cwd,
        command: record.command,
        tmuxSession: record.tmuxSession,
        type: record.type,
        cols,
        rows,
        tabId: targetTabId,
      }),
      tabId: targetTabId,
    }
  }
```

**Why the destination is created first (revised 2026-08-10, after measurement).**
An earlier draft moved the window, killed the source session, then recreated it
under the same name, with a rollback if that recreate failed. That rollback could
not work, and the implementer proved it before writing any code: in the
standalone-to-standalone case the source session self-destructs the instant its
only window leaves, so by the time the rollback ran, the session name it was
trying to move the window back into no longer existed. Its failure was swallowed
and the window stayed stranded in the target group.

Creating the destination first removes the failure rather than recovering from
it. `newGroupMember` is the one step likely to fail, and now nothing has moved
when it runs. It also creates no new window and no new shell, because a session
joining a group shares that group's existing window list. That matters: read
`newGroupMember`'s own comment in `src/main/tmux/adapter.ts`, which records 287
leaked shells against a 511-pty budget from a session founded outside a group.
Any fix that spawns a placeholder shell to move a window into is that same leak.

Measured on a throwaway socket, both cases: standalone onto standalone, and a
split member onto a standalone. In both, every shell kept its pid, each session
ended on its own distinct window, and `PTERM_TAB_ID` survived the rename.

The rest of the ordering: `detach` comes after the staging session exists but
before the move, and `cols`/`rows` are captured above it because `detach` deletes
the entry they live on.

**The staging session also removes the shadow hazard, which is why there is no
snapshot-and-restore of member selections here (revised 2026-08-10, measured
twice).** `move-window` re-points the session named in its `-t`, and in this
design that is always `staging`, never a session the user already has a pane in.
An earlier draft moved straight into the target pane's own session, and that DID
re-point it: measured, two sessions of one group both ended up showing window
`@2`. That is the state `withoutSharedWindows` (`src/main/ipc/restore.ts:154-162`)
reads as one session shadowing another, on which it calls `killShadowMember`,
losing a live pane on the next launch.

So the protection is now structural rather than compensatory. The test that holds
it is "leaves every member of the target group on a window of its own": it fails
if anyone changes the move to target a member session directly, which is exactly
the regression a restore loop would have been insurance against. Do not add the
loop back. A restore loop here would be code that cannot be made to fail, and the
comment justifying it would be false about its own design.

The `catch` kills only the staging session, never a window. If the move already
succeeded, the moved window stays in the target group with its shell running and
its pane recoverable, which is the behaviour the spec asks for: a stranded
window is acceptable, a dead shell is not.

- [ ] **Step 4: Write the failure test**

There is no rollback to write, because Step 3's ordering means the step most
likely to fail now runs before anything has changed. What needs proving is that
this is true: a failed join must leave the source pane exactly where it was,
with its shell alive.

```ts
it('leaves the source pane untouched when the join cannot start', async () => {
  manager.open({ id: 'aaa', projectSlug: 'demo', cwd })
  const moved = manager.open({ id: 'bbb', projectSlug: 'demo', cwd })
  await settle()
  const before = await panePid(moved.tmuxSession)
  vi.spyOn(adapter, 'newGroupMember').mockRejectedValueOnce(new Error('nope'))

  await expect(manager.joinTab({ paneId: 'bbb', targetPaneId: 'aaa' })).rejects.toThrow('nope')

  expect(await adapter.hasSession(moved.tmuxSession)).toBe(true)
  expect(await panePid(moved.tmuxSession)).toBe(before)
  const rows = await adapter.listSessionsWithGroups()
  expect(rows.find((row) => row.name === moved.tmuxSession)?.group).toBeFalsy()
})
```

Three assertions, each failing on a different regression: the session still
exists, its shell is the same process, and it is still ungrouped rather than
half-joined to the target.

- [ ] **Step 5: Write the staging-cleanup test**

A failure AFTER the staging session exists must not leave that session behind,
because a stray `pterm-*` session is one nothing in the app can ever see or
reach again.

```ts
it('cleans up the staging session when the move fails', async () => {
  manager.open({ id: 'aaa', projectSlug: 'demo', cwd })
  const moved = manager.open({ id: 'bbb', projectSlug: 'demo', cwd })
  await settle()
  vi.spyOn(adapter, 'moveWindow').mockRejectedValueOnce(new Error('nope'))

  await expect(manager.joinTab({ paneId: 'bbb', targetPaneId: 'aaa' })).rejects.toThrow('nope')

  const names = (await adapter.listSessionsWithGroups()).map((row) => row.name)
  expect(names.filter((name) => name.includes('-joining'))).toEqual([])
  expect(await adapter.hasSession(moved.tmuxSession)).toBe(true)
})
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/join.test.ts`
Expected: PASS, all seven.

- [ ] **Step 7: Prove the load-bearing step is load-bearing**

Mutate the move to target the target pane's session directly, in other words
replace the staging move with
`await this.adapter.moveWindow(record.tmuxSession, target.record.tmuxSession)`,
re-run the file, and confirm "leaves every member of the target group on a window
of its own" FAILS. Then restore the staging move.

That mutation is the old, wrong design, and it is what this test exists to
reject. If the test still passes under it, the test is not testing what it claims
and must be fixed before moving on, because the failure it is meant to catch is
one that costs the user a live pane on their next launch and is invisible until
then.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/main/sessions/manager.ts tests/integration/join.test.ts
git commit -m "Move a live pane between tmux groups with joinTab"
```

---

### Task 3: The channel, the shape and the bridge

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/preload.ts`

**Interfaces:**
- Produces:
  - `CHANNELS.joinPane = 'pterm:joinPane'`
  - `interface JoinShape { panes: TabDescriptor[]; tabs: TabRow[]; dropped: string | null }`
  - `PTermBridge.joinPane(paneId: string, targetPaneId: string): Promise<JoinShape>`

`JoinShape` is not `TabShape`. `TabShape` holds at most one row by contract, and
a join always changes two: the target gains a kid and the source loses one.
`dropped` names the source tab when it had no panes left and its row is gone,
and is null otherwise. `tabs` carries the target row always, and the source row
when it survives.

- [ ] **Step 1: Add the channel and the type**

In `src/shared/ipc.ts`, add `joinPane: 'pterm:joinPane'` to `CHANNELS` beside
`splitPane`, then add near `TabShape`:

```ts
export interface JoinShape {
  panes: TabDescriptor[]
  tabs: TabRow[]
  dropped: string | null
}
```

Add to the bridge interface beside `splitPane`:

```ts
  joinPane(paneId: string, targetPaneId: string): Promise<JoinShape>
```

- [ ] **Step 2: Wire the preload**

In `src/main/preload.ts`, beside the existing `splitPane` entry:

```ts
  joinPane: (paneId: string, targetPaneId: string) =>
    ipcRenderer.invoke(CHANNELS.joinPane, paneId, targetPaneId),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: one error per unimplemented handler is NOT expected here, because
`ipcMain.handle` is untyped. It should pass clean. If it does not, the bridge
type and the preload object have drifted; fix the preload.

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc.ts src/main/preload.ts
git commit -m "Declare the joinPane channel and its two-row reply shape"
```

---

### Task 4: The `joinPane` handler

**Files:**
- Modify: `src/main/ipc/register.ts`
- Test: `tests/integration/persistence.test.ts` (add cases there, following its
  existing store-and-handler conventions)

**Interfaces:**
- Consumes: `manager.joinTab` (Task 2), `JoinShape` (Task 3), and the existing
  `serialise`, `store`, `tombstones`, `withTabRow`, `held`, `carveRatio`,
  `registry`, plus `tabRowFor` already imported from `./restore`.
- Produces: the `CHANNELS.joinPane` handler.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/persistence.test.ts`. That file already captures the
handlers into an `ipc.handlers` map and exposes `invoke<T>(channel, ...args)`
(around line 168); open panes with `invoke(CHANNELS.open, ...)` and split with
`invoke(CHANNELS.splitPane, ...)` exactly as the neighbouring tests do, rather
than reaching for `SessionManager` directly.

```ts
it('writes one row holding both panes after a join', async () => {
  // open two standalone panes through the handlers, then:
  const shape = await invoke<JoinShape>(CHANNELS.joinPane, 'bbb', 'aaa')

  expect(shape.tabs.find((row) => row.id === 'aaa')?.layout.kids).toEqual(['aaa', 'bbb'])
  expect(shape.dropped).toBe('bbb')
  const config = await store.read()
  expect(config.tabs.find((row) => row.id === 'bbb')).toBeUndefined()
})

it('keeps the source tab when it still has a pane left', async () => {
  // aaa split into aaa+ddd, ccc standalone, then move ddd onto ccc:
  const shape = await invoke(CHANNELS.joinPane, 'ddd', 'ccc')

  expect(shape.dropped).toBeNull()
  expect(shape.tabs.find((row) => row.id === 'aaa')?.layout.kids).toEqual(['aaa'])
  expect(shape.tabs.find((row) => row.id === 'ccc')?.layout.kids).toEqual(['ccc', 'ddd'])
})

it('keeps the target tab existing axis instead of re-orienting it', async () => {
  // aaa split downward so its row is dir 'col', ccc standalone,
  // then move ccc onto aaa:
  const shape = await invoke(CHANNELS.joinPane, 'ccc', 'aaa')

  expect(shape.tabs.find((row) => row.id === 'aaa')?.layout.dir).toBe('col')
})

it('hands the source tab active pane to a survivor', async () => {
  // aaa split into aaa+ddd with ddd active, ccc standalone,
  // then move ddd onto ccc:
  await invoke(CHANNELS.joinPane, 'ddd', 'ccc')

  const config = await store.read()
  expect(config.tabs.find((row) => row.id === 'aaa')?.activePaneId).toBe('aaa')
})
```

Fill the setup comments in with the same handler calls the neighbouring tests in
that file already use to open and split panes. Do not invent a new fixture.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/integration/persistence.test.ts -t join`
Expected: FAIL, no handler registered for `pterm:joinPane`.

- [ ] **Step 3: Implement the handler**

Add to `src/main/ipc/register.ts`, after the `CHANNELS.splitPane` handler:

```ts
  ipcMain.handle(
    CHANNELS.joinPane,
    async (_event, paneId: string, targetPaneId: string): Promise<JoinShape> => {
      const sourceTabId = manager.tabIdOf(paneId)
      if (!sourceTabId) throw new Error(`Cannot join: pane ${paneId} is not open`)

      const { record, tabId } = await manager.joinTab({ paneId, targetPaneId })
      const targetGroupId = await manager.groupIdOf(tabId)
      const sourceGroupId = await manager.groupIdOf(sourceTabId)

      return serialise(async () => {
        const config = await store.read()
        const panes = [...config.panes.filter((saved) => saved.id !== record.id), record]
        const listed = new Set(panes.map((pane) => pane.id))

        const savedTarget = config.tabs.find((row) => row.id === tabId)
        const targetSavedKids = savedTarget?.layout.kids ?? [targetPaneId]
        const targetUnclaimed = (await manager.panesOfTab(tabId))
          .map((pane) => pane.id)
          .filter((id) => id !== record.id && !targetSavedKids.includes(id) && listed.has(id))
        const siblings = [...targetSavedKids, ...targetUnclaimed]
        const targetKids = [...siblings, record.id]

        const targetRow: TabRow = {
          id: tabId,
          groupId: targetGroupId,
          activePaneId: record.id,
          layout: {
            dir: savedTarget?.layout.dir ?? 'row',
            ratio: carveRatio({
              tabId,
              kids: targetKids,
              sourcePaneId: targetPaneId,
              newPaneId: record.id,
              siblings,
              savedKids: targetSavedKids,
              savedRatio: savedTarget?.layout.ratio ?? [],
              tombstones,
            }),
            kids: targetKids,
          },
        }

        const savedSource = config.tabs.find((row) => row.id === sourceTabId)
        const sourceSavedKids = savedSource?.layout.kids ?? []
        const sourceUnclaimed = (await manager.panesOfTab(sourceTabId))
          .map((pane) => pane.id)
          .filter(
            (id) => id !== record.id && !sourceSavedKids.includes(id) && listed.has(id),
          )
        const sourceKids = [
          ...sourceSavedKids.filter((kid) => kid !== record.id),
          ...sourceUnclaimed,
        ]
        const sourceRow: TabRow | null =
          sourceKids.length > 0
            ? tabRowFor(
                { id: sourceTabId, groupId: sourceGroupId },
                sourceKids,
                savedSource,
                tombstones,
              )
            : null

        const tabs = withTabRow(
          withTabRow(config.tabs, tabId, targetRow),
          sourceTabId,
          sourceRow,
        )
        await store.write({ ...config, panes, tabs })

        const rows = sourceRow ? [targetRow, sourceRow] : [targetRow]
        const named = new Set(rows.flatMap((row) => row.layout.kids))
        return {
          panes: panes.filter((pane) => named.has(pane.id)),
          tabs: rows,
          dropped: sourceRow ? null : sourceTabId,
        }
      })
    },
  )
```

`tabRowFor` gives the source row the same treatment `closePane` gives a tab that
has lost a pane, including handing `activePaneId` to a survivor, so this handler
does not need its own copy of that rule. Import `JoinShape` alongside the other
shared types at the top of the file.

**The order of `tabs` is load-bearing and must be written down (added after the
Task 3 review).** The target row goes FIRST and the source row second. Task 5's
reducer reads `shape.tabs[0].activePaneId` to decide which pane to focus, so
emitting the source row first would focus the wrong pane, and nothing in the
type would catch it: both entries are `TabRow`, so the two orderings are
indistinguishable to the compiler and to every test that does not assert focus.

`JoinShape`'s doc comment in `src/shared/ipc.ts` currently states the ordering
of panes WITHIN a tab and says nothing about the order of `tabs` itself. As part
of this task, add that sentence to the comment, so the contract lives next to the
type both sides read rather than only in this plan.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/persistence.test.ts`
Expected: PASS, including the file's pre-existing tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/main/ipc/register.ts tests/integration/persistence.test.ts
git commit -m "Rewrite both tab rows when a pane joins another tab"
```

---

### Task 5: The renderer reducer

**Files:**
- Modify: `src/renderer/workspace.ts`
- Test: `tests/unit/workspace.test.ts`

**Interfaces:**
- Consumes: `JoinShape` (Task 3), existing `withKeptPanes`, `setActiveTab`,
  `projectIdForTab`.
- Produces: a `{ type: 'joined'; shape: JoinShape }` action and
  `applyJoinShape(state: WorkspaceState, shape: JoinShape): WorkspaceState`.

`applyTabShape` cannot be reused. Its doc comment states it only ever replaces
or inserts one row and deliberately never subtracts, which is exactly what a
join needs it to do.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/workspace.test.ts`:

```ts
it('folds both rows of a join into state', () => {
  const state = reduce(seeded, {
    type: 'joined',
    shape: {
      panes: [paneA, paneB],
      tabs: [
        { id: 'aaa', groupId: 'aaa', activePaneId: 'bbb', layout: { dir: 'row', ratio: [0.5, 0.5], kids: ['aaa', 'bbb'] } },
      ],
      dropped: 'bbb',
    },
  })

  expect(state.tabs.find((row) => row.id === 'aaa')?.layout.kids).toEqual(['aaa', 'bbb'])
  expect(state.tabs.find((row) => row.id === 'bbb')).toBeUndefined()
})

it('keeps a source row that survived the join', () => {
  const state = reduce(seeded, {
    type: 'joined',
    shape: {
      panes: [paneA, paneC, paneD],
      tabs: [
        { id: 'ccc', groupId: 'ccc', activePaneId: 'ddd', layout: { dir: 'row', ratio: [0.5, 0.5], kids: ['ccc', 'ddd'] } },
        { id: 'aaa', groupId: 'aaa', activePaneId: 'aaa', layout: { dir: 'row', ratio: [1], kids: ['aaa'] } },
      ],
      dropped: null,
    },
  })

  expect(state.tabs.find((row) => row.id === 'aaa')?.layout.kids).toEqual(['aaa'])
  expect(state.tabs.find((row) => row.id === 'ccc')?.layout.kids).toEqual(['ccc', 'ddd'])
})

it('makes the joined pane the active tab of its project', () => {
  const state = reduce(seeded, {
    type: 'joined',
    shape: {
      panes: [paneA, paneB],
      tabs: [
        { id: 'aaa', groupId: 'aaa', activePaneId: 'bbb', layout: { dir: 'row', ratio: [0.5, 0.5], kids: ['aaa', 'bbb'] } },
      ],
      dropped: 'bbb',
    },
  })

  expect(activeTabId(state)).toBe('bbb')
})
```

Reuse whatever `seeded`, `paneA` style fixtures that file already defines rather
than adding new ones.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/workspace.test.ts -t join`
Expected: FAIL, the `joined` action falls through the reducer and state is
unchanged.

- [ ] **Step 3: Implement**

Add to `src/renderer/workspace.ts`, beside `applyTabShape`:

```ts
function applyJoinShape(state: WorkspaceState, shape: JoinShape): WorkspaceState {
  const panes = [
    ...state.panes.map((pane) => shape.panes.find((incoming) => incoming.id === pane.id) ?? pane),
    ...shape.panes.filter((incoming) => !state.panes.some((pane) => pane.id === incoming.id)),
  ]

  let tabs = state.tabs.filter((row) => row.id !== shape.dropped)
  for (const incoming of shape.tabs) {
    const row = withKeptPanes(
      tabs.find((candidate) => candidate.id === incoming.id),
      incoming,
      panes,
    )
    tabs = tabs.some((candidate) => candidate.id === row.id)
      ? tabs.map((candidate) => (candidate.id === row.id ? row : candidate))
      : [...tabs, row]
  }

  const next = { ...state, panes, tabs }
  const joined = shape.tabs[0]?.activePaneId
  const pane = joined ? panes.find((candidate) => candidate.id === joined) : undefined
  return pane ? setActiveTab(next, projectIdForTab(next.projects, pane), pane.id) : next
}
```

`shape.tabs[0]` is the target row by the handler's construction: it pushes the
target first and the source, when it survives, second.

Add the action to the reducer beside the `split` case:

```ts
    case 'joined':
      return applyJoinShape(state, action.shape)
```

and to the action union:

```ts
  | { type: 'joined'; shape: JoinShape }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/renderer/workspace.ts tests/unit/workspace.test.ts
git commit -m "Fold a two-row join reply into workspace state"
```

---

### Task 6: The drag gesture

**Files:**
- Create: `src/renderer/lib/usePaneDragDrop.ts`
- Modify: `src/renderer/TabsPanel.tsx`
- Modify: `src/renderer/TabBar.tsx`
- Modify: `src/renderer/App.tsx`

**RULING (2026-08-10, decided by the human partner before execution):** the two
surfaces share ONE hook rather than each carrying a copy of the handlers. An
earlier draft of this task told you to duplicate five handlers and two pieces of
state into `TabBar.tsx`. Do not do that. The requirement is that both surfaces
behave identically, and a shared hook is what makes that true by construction
instead of by inspection.

**Interfaces:**
- Consumes: `bridge.joinPane` (Task 3), the `joined` action (Task 5).
- Produces two new props, identical on both `TabsPanel` and `TabBar`:
  - `onJoin: (paneId: string, targetPaneId: string) => void`
  - `canJoin: (paneId: string, targetPaneId: string) => boolean`

`canJoin` is a prop rather than a rule each surface derives, because the two
surfaces must refuse identically and neither of them knows about tab rows or
projects. `App.tsx` owns the rule and both surfaces ask it.

The MIME type is `application/x-pterm-pane`. A bare `text/plain` would let any
dragged text look like a pane id, and would let a pane id dropped into a
terminal read as a paste.

- [ ] **Step 1: Write the shared hook**

Create `src/renderer/lib/usePaneDragDrop.ts`. It owns the two pieces of state
and returns a function giving one pane's handler props, so a surface spreads the
result onto each row or tab element and carries no drag logic of its own.

```tsx
import { useState } from 'react'

export interface PaneDragDrop {
  /** Spread onto the element representing `paneId`. */
  propsFor: (paneId: string) => {
    draggable: true
    onDragStart: (event: React.DragEvent) => void
    onDragEnd: () => void
    onDragOver: (event: React.DragEvent) => void
    onDragLeave: () => void
    onDrop: (event: React.DragEvent) => void
  }
  /** The pane currently under a valid drag, for the drop highlight. */
  over: string | null
}

const MIME = 'application/x-pterm-pane'

export function usePaneDragDrop(
  canJoin: (from: string, to: string) => boolean,
  onJoin: (from: string, to: string) => void,
): PaneDragDrop {
  const [dragged, setDragged] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  return {
    over,
    propsFor: (paneId: string) => ({
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        event.stopPropagation()
        event.dataTransfer.setData(MIME, paneId)
        event.dataTransfer.effectAllowed = 'move'
        setDragged(paneId)
      },
      onDragEnd: () => {
        setDragged(null)
        setOver(null)
      },
      onDragOver: (event: React.DragEvent) => {
        if (!dragged || !canJoin(dragged, paneId)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setOver(paneId)
      },
      onDragLeave: () => setOver((was) => (was === paneId ? null : was)),
      onDrop: (event: React.DragEvent) => {
        const from = event.dataTransfer.getData(MIME) || dragged
        setOver(null)
        setDragged(null)
        if (!from || !canJoin(from, paneId)) return
        event.preventDefault()
        onJoin(from, paneId)
      },
    }),
  }
}
```

`dragged` exists because `dataTransfer.getData` returns an empty string during
`dragover` by browser design: only the TYPE is readable there, not the value. So
the id the refusal rule needs during the hover has to be held in state, and
`getData` is used only on `drop`, where it does work. `|| dragged` in `onDrop`
covers a drop that arrives with a cleared `dataTransfer`.

`event.stopPropagation()` on `onDragStart` matters: the tabs column heading is
itself a drag source for column reordering, and without it a row drag also
starts a column drag.

The MIME type is deliberate. A bare `text/plain` would let any dragged text look
like a pane id, and would let a pane id dropped into a terminal read as a paste.

- [ ] **Step 2: Use the hook in `TabsPanel`**

Call `usePaneDragDrop(canJoin, onJoin)` once in the component and spread
`propsFor(pane.id)` onto each row `div` in `row(...)`. Give the highlighted row
a ring by extending its `className` with
`over === pane.id ? 'ring-1 ring-inset ring-accent' : ''` through the existing
`cn(...)` call, and add `data-over={over === pane.id || undefined}` so the e2e
specs have something to assert on.

- [ ] **Step 3: Use the same hook in `TabBar`**

Read `src/renderer/TabBar.tsx` and call `usePaneDragDrop(canJoin, onJoin)` there
too, spreading `propsFor(<pane id>)` onto each tab element and using `over` for
its highlight. No drag logic is written twice: if you find yourself copying a
handler body out of the hook, stop and widen the hook instead.

Match the bar's own visual language for the highlight rather than transplanting
the column's ring, and add the same `data-over` attribute.

- [ ] **Step 4: Wire `App.tsx`**

Add beside the existing split handler in `src/renderer/App.tsx`:

```tsx
  const joinPanes = useCallback(
    (paneId: string, targetPaneId: string) => {
      void window.pterm
        .joinPane(paneId, targetPaneId)
        .then((shape) => dispatch({ type: 'joined', shape }))
        .catch((error) => {
          console.error('pTerm: could not join those tabs', error)
        })
    },
    [dispatch],
  )
```

Define the whole refusal rule once, here, and pass it plus `joinPanes` to both
`<TabsPanel>` and `<TabBar>`:

```tsx
  const canJoin = useCallback(
    (from: string, to: string): boolean => {
      if (from === to) return false
      const fromPane = state.panes.find((pane) => pane.id === from)
      const toPane = state.panes.find((pane) => pane.id === to)
      if (!fromPane || !toPane) return false
      if (fromPane.projectSlug !== toPane.projectSlug) return false
      const tabOf = (paneId: string) =>
        state.tabs.find((row) => row.layout.kids.includes(paneId))?.id ?? paneId
      return tabOf(from) !== tabOf(to)
    },
    [state.panes, state.tabs],
  )
```

Three refusals, one rule. `tabOf` falls back to the pane's own id rather than
null because a pane no row names is a tab of one that has never been split, and
reading that as "unknown, so refuse" would make the commonest case in the app
undraggable. The `projectSlug` comparison is the cross-project refusal: a tmux
group belongs to one project by its session name, so a join across projects
would put a pane in a group whose name carries a different slug.

Pass `onJoin={joinPanes}` and `canJoin={canJoin}` to both surfaces.

- [ ] **Step 5: Verify by hand**

Run: `npm start`. Open three tabs. Drag one onto another. Confirm the two
appear bracketed in the Tabs column, both terminals still show their scrollback,
and anything that was running in the dragged tab is still running. Then quit and
relaunch and confirm the split is still there. This is the check no test in this
plan performs.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/renderer/lib/usePaneDragDrop.ts src/renderer/TabsPanel.tsx src/renderer/TabBar.tsx src/renderer/App.tsx
git commit -m "Drag a tab onto another to merge them into a split"
```

---

### Task 7: End-to-end specs

**Files:**
- Create: `tests/e2e/dragSplit.spec.ts`

Playwright's `dragTo` does not drive HTML5 drag-and-drop reliably in Electron,
so these dispatch the events with a shared `DataTransfer` directly.

- [ ] **Step 1: Write the specs**

Model the file's socket, temp-dir and `launchApp` setup on the top of
`tests/e2e/splits.spec.ts`, with its OWN socket name (`pterm-e2e-dragsplit`) so
it never shares a tmux server with another spec file. Reuse `launchApp`,
`killServer` and `sessionNames` from `./harness`.

```ts
/**
 * The pane ids of the tabs column, in the order the column draws them.
 * The column names every row `vpane-<paneId>` (`TabsPanel.tsx`).
 */
async function columnPaneIds(window: Page): Promise<string[]> {
  const rows = window.locator('[data-testid^="vpane-"]')
  await expect(rows.first()).toBeVisible()
  return (
    await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.testid ?? ''))
  ).map((id) => id.replace('vpane-', ''))
}

/**
 * One drag gesture, dispatched directly.
 *
 * Playwright's own dragTo drives pointer events, which HTML5 drag-and-drop in
 * Electron does not synthesise into drag events. One shared DataTransfer across
 * all three dispatches is what makes getData work on the drop.
 */
async function dragPaneOnto(window: Page, from: string, to: string): Promise<void> {
  await window.evaluate(
    ([fromId, toId]) => {
      const source = document.querySelector(`[data-testid="vpane-${fromId}"]`)
      const target = document.querySelector(`[data-testid="vpane-${toId}"]`)
      if (!source || !target) throw new Error(`missing row: ${fromId} or ${toId}`)
      const dataTransfer = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }))
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
    },
    [from, to],
  )
}

test('dragging a tab onto another brackets them as one split', async () => {
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  const [first, second] = await columnPaneIds(window)

  await dragPaneOnto(window, second, first)

  await expect(window.getByTestId(`vpane-${first}`)).toHaveAttribute('data-bracket', 'first')
  await expect(window.getByTestId(`vpane-${second}`)).toHaveAttribute('data-bracket', 'last')
  expect((await sessionNames(SOCKET)).length).toBe(2)
})

test('a tab dropped on itself is refused', async () => {
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const [only] = await columnPaneIds(window)

  await dragPaneOnto(window, only, only)

  await expect(window.getByTestId(`vpane-${only}`)).not.toHaveAttribute('data-bracket', 'first')
})

test('a pane is refused as a drop target inside its own tab', async () => {
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.keyboard.press('Meta+d')
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  const [first, sibling] = await columnPaneIds(window)

  await dragPaneOnto(window, sibling, first)

  await expect(window.getByTestId(`vpane-${sibling}`)).toHaveAttribute('data-bracket', 'last')
  expect((await sessionNames(SOCKET)).length).toBe(2)
})
```

The tabs column must be open for `vpane-` rows to exist. If the app under test
starts with it collapsed, expand it first through `tabs-toggle`, and read the
warning in the repo notes about that testid: the collapsed strip and the open
heading share it, so a blind click can close the column instead of opening it.
Assert the panel is present after the click rather than assuming.

The session count assertions are doing real work: they are what separates a
merge from a close-and-respawn. If a join ever dropped to approach B, the count
would still be 2 but the pids would differ, which is why Task 2 owns the pid
assertions and this file owns the shape.

Note for whoever writes these: `splits.spec.ts` pixel constants encode the whole
flex row of columns, and 27 or more locators in the e2e suite count tabs with
`[data-testid^="tab-"]`. Do not introduce a new per-tab testid under that
prefix, or every one of those counts inflates.

- [ ] **Step 2: Run the specs**

Run: `npx playwright test tests/e2e/dragSplit.spec.ts`
Expected: PASS, all three.

- [ ] **Step 3: Run the full e2e suite**

Run: `npm run e2e`
Expected: no new failures. Compare against a baseline run taken BEFORE this
branch, because a peer session shares this checkout and unrelated failures are
not necessarily yours.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dragSplit.spec.ts
git commit -m "Cover the drag-to-split gesture end to end"
```

---

## Final gates

- [ ] `npm run typecheck` silent
- [ ] `npm test` green, including the new integration files
- [ ] `npm run e2e` green
- [ ] The hand pass from Task 6 Step 5 done, including the relaunch
- [ ] The sabotage check from Task 2 Step 5 recorded in the commit or the PR

## Known gaps, deliberately

- Nothing tests the feature against two real windows, because the app is
  single-window by construction.
- Dragging a whole multi-pane tab, and dropping on empty space to un-split, are
  out of scope per the spec. There is no un-group path in the code, and nothing
  in scope needs one.
