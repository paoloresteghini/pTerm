# M2c Splits — Core Model Implementation Plan (1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tab a tmux session group whose panes are windows with their own
member sessions, so one pane can crash without taking its siblings down.

**Architecture:** A tab is a tmux session *group*. A pane is one window (holding
the process) plus one member session bound to that window (giving the xterm its
own view). A one-pane tab is a group of size one — `session_group` empty — which
is byte for byte what the app creates today, so splits are purely additive. Each
pane window carries its own window-scoped `pane-died` hook that reaps that pane's
window and member session and nothing else.

**Tech Stack:** TypeScript, Electron main process, node-pty, real tmux 3.7b via
`TmuxAdapter`, Vitest (`npm test`), Playwright for E2E (`npm run e2e`).

**Scope:** This is plan 1 of 2. It covers the tmux layer and the session model —
everything headless and integration-testable. Plan 2 covers config v5, restore
reconcile, IPC and the renderer pane tree. This plan is complete and testable on
its own: at the end, splits work through `SessionManager`, and the M2c blocker is
discharged and proved against real tmux.

**Spec:** `docs/superpowers/specs/2026-07-31-prcli-m2c-splits-design.md`

## Global Constraints

- Tests use `-L prcli-test` only, via `PRCLI_TMUX_SOCKET` / `new TmuxAdapter({ socket: 'prcli-test' })`. **Never the default socket.** `tmux -L prcli-test kill-server` is the established per-socket teardown and is fine; a *bare* `kill-server` is not.
- Tests never touch the real `~/.prcli` (`PRCLI_CONFIG_DIR`), `~/Code` (`PRCLI_PROJECTS_ROOT`), or `~/.claude/settings.json` (`PRCLI_CLAUDE_SETTINGS`). The last is read by roughly twelve live Claude sessions.
- **Never run `npm install` / `npm ci`.** It breaks node-pty's spawn-helper permissions and fails all integration tests with `posix_spawnp failed`. A `postinstall` repairs it; that error means this rule was broken.
- **Never weaken or delete a test assertion to make code pass.** If an assertion contradicts the code, stop and report.
- Slugs are immutable, `/^[a-z0-9_]+$/`, underscores never dashes.
- All tmux goes through `TmuxAdapter`.
- **Target syntax.** `=name` is exact-match. Window- and pane-scoped commands (`set-option`, `show-options`, `display-message`, `split-window`, `list-panes`) need a **trailing colon**: `=name:`. Session-target commands (`has-session`, `kill-session`, `rename-session`, `list-clients`, `show-environment`) must **not** have it. This produced a plausible wrong answer three separate times during design probes — `can't find pane`, `no such window`, an empty format — never an obvious failure.
- **tmux expands `#{...}` inside `run-shell`'s argument, but not in other command arguments.** `kill-window -t #{window_id}` fails with `-t expects an argument`. Every id in a hook command outside `run-shell` must be a literal, baked in at install time.
- **A group name is for joining only.** `new-session -t <group>` accepts it even after the founding session is gone (measured). `set-option -t '=<group>:'` does **not** — it fails `no such window` once the founder dies. Every option, window and pane target must name a *live member session*, never the group.
- **Never rely on a tmux option being shared between group members.** Two design probes disagreed on whether `window-size` propagates. Set every option explicitly on the member (or window) it must apply to. A setting that happens to propagate is not a setting that was made.
- **Binding a member to a window needs the window INDEX, not just its id.** `select-window -t '=<member>:<index>'`. A bare `select-window -t @7` picks a session tmux chooses, not the one you meant, and a doubled `-t` silently keeps only the last — both bind nothing while exiting 0.
- A/B every load-bearing assertion: sabotage the production code and watch the test fail. Three tests were found passing against broken code this way on 2026-07-31.

---

### Task 1: The death hook reaps one pane, not the whole tab

The shipped hook ends in `kill-session -t =<session>`, correct only when a
session has one pane. It becomes window-scoped and reaps exactly the dying
pane's window and member session.

**Files:**
- Modify: `src/main/pty/deathHook.ts:29-49`
- Test: `tests/unit/deathHook.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `deathHookCommand(input: { reporter: string; tabId: string; tmuxSession: string; windowId: string }): string | null` — same guard behaviour, one new required field. `windowId` is a tmux window id of the form `@<digits>`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/deathHook.test.ts`:

```ts
it('reaps the dying pane\'s window and member session, in that order', () => {
  const command = deathHookCommand({
    reporter: '/tmp/prcli/prcli-hook',
    tabId: 'a1b2c3d4e5f60718',
    tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
    windowId: '@7',
  })
  // The member's client must be gone before its window is: a member whose
  // bound window dies first falls back to a SIBLING's window, and two xterms
  // then render the same pane. Measured 2026-07-31.
  expect(command).toBe(
    `run-shell "PRCLI_TAB_ID=a1b2c3d4e5f60718 '/tmp/prcli/prcli-hook' Exit ` +
      `'#{pane_dead_status}' '#{pane_dead_signal}'" ; ` +
      `kill-session -t =prcli-lumio-a1b2c3d4e5f60718 ; kill-window -t @7`,
  )
})

// tmux does not expand formats in a command argument outside run-shell, so the
// window id is baked in literally. A format arriving here would reach tmux
// unexpanded and kill-window would fail with "-t expects an argument".
it('refuses a window id that is not a literal @<digits>', () => {
  for (const windowId of ['#{window_id}', '@', '7', '@7;kill-server', '']) {
    expect(
      deathHookCommand({
        reporter: '/tmp/prcli/prcli-hook',
        tabId: 'a1b2c3d4e5f60718',
        tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
        windowId,
      }),
    ).toBeNull()
  }
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/deathHook.test.ts`
Expected: FAIL — the command lacks `kill-window`, and the shape test passes an
unknown property.

- [ ] **Step 3: Implement**

In `src/main/pty/deathHook.ts`, add beside `TAB_ID_RE`:

```ts
/** A tmux window id. Baked in literally: formats are not expanded here. */
const WINDOW_ID_RE = /^@\d+$/
```

Extend the input type with `windowId: string`, add `if (!WINDOW_ID_RE.test(input.windowId)) return null` beside the other guards, and change the return to:

```ts
  return (
    `run-shell "${report}" ; kill-session -t =${input.tmuxSession} ; ` +
    `kill-window -t ${input.windowId}`
  )
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/deathHook.test.ts`
Expected: PASS, including the ten pre-existing guard tests.

- [ ] **Step 5: A/B the ordering assertion**

Swap `kill-session` and `kill-window` in the returned string, re-run, and confirm
the ordering test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/main/pty/deathHook.ts tests/unit/deathHook.test.ts
git commit -m "Let the death hook reap one pane instead of the whole tab"
```

---

### Task 2: Adapter learns windows and groups

**Files:**
- Modify: `src/main/tmux/adapter.ts`
- Test: `tests/integration/adapter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, on `TmuxAdapter`:
  - `listSessionsWithGroups(): Promise<{ name: string; group: string }[]>` — `group` is `''` for an ungrouped session.
  - `windowIdOf(session: string): Promise<string>` — the session's current window id, `''` if tmux will not say.
  - `killWindow(windowId: string): Promise<void>` — tolerates an already-gone window.
  - `selectWindow(session: string, windowIndex: string): Promise<void>` — binds a member to a window **by index**, not by id.
  - `resizeWindow(windowId: string, cols: number, rows: number): Promise<void>`
  - `setWindowHook(windowId: string, hook: string, command: string): Promise<void>`
  - `setWindowOption(windowId: string, option: string, value: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/adapter.test.ts` (it already has `SOCKET`, `run` and `killServer` helpers — reuse them):

```ts
describe('TmuxAdapter groups and windows', () => {
  it('reports an empty group for an ungrouped session and the group name for members', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'solo', 'sleep', '600'])
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'founder', 'sleep', '600'])
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-t', 'founder', '-s', 'member'])

    const rows = await adapter.listSessionsWithGroups()

    expect(rows).toEqual(
      expect.arrayContaining([
        { name: 'solo', group: '' },
        { name: 'founder', group: 'founder' },
        { name: 'member', group: 'founder' },
      ]),
    )
  })

  it('resizes one window without touching its sibling', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'f', '-x', '80', '-y', '24', 'sleep', '600'])
    const first = await adapter.windowIdOf('f')
    await run('tmux', ['-L', SOCKET, 'new-window', '-t', '=f:', 'sleep', '600'])
    const second = await adapter.windowIdOf('f')
    expect(second).not.toBe(first)

    await adapter.setSessionOption('f', 'window-size', 'manual')
    await adapter.resizeWindow(first, 100, 30)
    await adapter.resizeWindow(second, 200, 50)

    expect(await windowSizeOf(first)).toBe('100x30')
    expect(await windowSizeOf(second)).toBe('200x50')
  })

  it('kills a window without killing the session that also holds another', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'f', 'sleep', '600'])
    await run('tmux', ['-L', SOCKET, 'new-window', '-t', '=f:', 'sleep', '600'])
    const doomed = await adapter.windowIdOf('f')

    await adapter.killWindow(doomed)

    expect(await adapter.hasSession('f')).toBe(true)
    await expect(adapter.killWindow(doomed)).resolves.toBeUndefined()
  })
})
```

Add this helper beside the file's existing ones:

```ts
/** What tmux says a window measures, by window id. */
async function windowSizeOf(windowId: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', windowId, '#{window_width}x#{window_height}',
  ])
  return stdout.trim()
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/integration/adapter.test.ts`
Expected: FAIL — the methods do not exist.

- [ ] **Step 3: Implement**

Append to `TmuxAdapter` in `src/main/tmux/adapter.ts`:

```ts
  /**
   * Every session with the group it belongs to, `''` when it belongs to none.
   *
   * A one-pane tab is an ungrouped session, so an empty group is the common
   * case rather than an error. This is what reassembles tabs from live tmux
   * instead of from anything stored.
   */
  async listSessionsWithGroups(): Promise<{ name: string; group: string }[]> {
    try {
      const stdout = await this.exec([
        'list-sessions', '-F', '#{session_name}\t#{session_group}',
      ])
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, group = ''] = line.split('\t')
          return { name, group }
        })
    } catch (error) {
      if (isNoServer(error)) return []
      throw error
    }
  }

  /**
   * The window the session is currently showing, or `''` if tmux will not say.
   *
   * Trailing colon: without it this is an exact-match window target and tmux
   * answers "can't find pane".
   */
  async windowIdOf(name: string): Promise<string> {
    try {
      return (
        await this.exec(['display-message', '-p', '-t', `=${name}:`, '#{window_id}'])
      ).trim()
    } catch {
      return ''
    }
  }

  /**
   * A window id (`@7`) is already an exact target and takes no `=` or colon.
   * Killing one that has gone is success — the death hook may have reaped it
   * a moment earlier, and that race is expected rather than exceptional.
   */
  async killWindow(windowId: string): Promise<void> {
    try {
      await this.exec(['kill-window', '-t', windowId])
    } catch (error) {
      if (error instanceof TmuxNotInstalledError) throw error
      if (/can't find window/i.test(stderrOf(error)) || isNoServer(error)) return
      throw error
    }
  }

  /**
   * Bind a member session to the window it is the view of.
   *
   * By INDEX, and with the member named. Measured: a bare `select-window -t @7`
   * binds whichever session tmux picks — in the probe, the wrong one — and a
   * doubled `-t` silently keeps only the last, so both bind nothing and exit 0.
   * Members of a group share one window list, so the index is the same for all
   * of them and naming the member is what makes this unambiguous.
   */
  async selectWindow(name: string, windowIndex: string): Promise<void> {
    await this.exec(['select-window', '-t', `=${name}:${windowIndex}`])
  }

  /**
   * A window-scoped option. `remain-on-exit` is set this way rather than on the
   * session so a sibling pane's window is left alone — measured: the sibling
   * window reads unset afterwards.
   */
  async setWindowOption(windowId: string, option: string, value: string): Promise<void> {
    await this.exec(['set-option', '-w', '-t', windowId, option, value])
  }

  async resizeWindow(windowId: string, cols: number, rows: number): Promise<void> {
    await this.exec(['resize-window', '-t', windowId, '-x', String(cols), '-y', String(rows)])
  }

  /**
   * A window-scoped hook. Measured: a `pane-died` hook set with `-w` fires only
   * for its own window, where a session-scoped one is shared by every member of
   * the group.
   */
  async setWindowHook(windowId: string, hook: string, command: string): Promise<void> {
    await this.exec(['set-hook', '-w', '-t', windowId, hook, command])
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/integration/adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/tmux/adapter.ts tests/integration/adapter.test.ts
git commit -m "Teach the adapter about windows and session groups"
```

---

### Task 3: A tab id can be read out of a group name, and nothing else can

The group name is fixed when the group is founded and **does not follow a
rename**, so after `moveToProject` it still carries the *source* slug. Exactly
one field is ever read from it.

**Files:**
- Modify: `src/main/tmux/names.ts`
- Test: `tests/unit/names.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `tabIdFromGroupName(group: string): string | null` — the 16-hex id, or null if the string is not an encoded prcli name.

- [ ] **Step 1: Write the failing tests**

```ts
describe('tabIdFromGroupName', () => {
  it('returns the id half', () => {
    expect(tabIdFromGroupName('prcli-lumio-a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718')
  })

  // The whole reason this function exists rather than callers reaching for
  // decodeSessionName: a group name keeps the slug it was founded with, so
  // after a move to `gco` the group still says `lumio`. The id is the only
  // field that stays true, and it is the only one anything may read.
  it('returns the same id after the tab has moved project', () => {
    const founded = 'prcli-lumio-a1b2c3d4e5f60718'
    expect(tabIdFromGroupName(founded)).toBe('a1b2c3d4e5f60718')
    expect(decodeSessionName(founded)?.projectSlug).toBe('lumio')
  })

  it('returns null for anything that is not an encoded prcli name', () => {
    for (const value of ['', 'lumio', 'prcli-lumio', 'prcli-lumio-nothex', 'other-lumio-a1b2c3d4e5f60718']) {
      expect(tabIdFromGroupName(value)).toBeNull()
    }
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/names.test.ts`
Expected: FAIL — `tabIdFromGroupName` is not exported.

- [ ] **Step 3: Implement**

Append to `src/main/tmux/names.ts`:

```ts
/**
 * The tab id inside a tmux group name.
 *
 * A group takes the name its founding session had **at the moment the group was
 * created, and never follows a rename** — measured on tmux 3.7b. So after
 * `moveToProject` renames every member to the new slug, the group name still
 * contains the old one. `decodeSessionName(group).projectSlug` therefore returns
 * a plausible, wrong answer, and nothing may ask it.
 *
 * The id half is safe: `moveToProject` preserves the id and changes only the
 * slug, so this value is stable for the tab's whole life.
 */
export function tabIdFromGroupName(group: string): string | null {
  return decodeSessionName(group)?.id ?? null
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/names.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/tmux/names.ts tests/unit/names.test.ts
git commit -m "Read only the id out of a group name, never its stale slug"
```

---

### Task 4: `TabRecord` becomes `PaneRecord`

A mechanical rename, done on its own so the behavioural tasks that follow have a
clean diff. `PRCLI_TAB_ID` **keeps its name** — it is on the wire, in the
reporter script, in `settings.json`, and in roughly twelve live sessions.

**Files:**
- Modify: `src/main/sessions/manager.ts`, `src/main/state/store.ts`, `src/main/ipc/restore.ts`, `src/main/ipc/register.ts`, `src/shared/ipc.ts`
- Test: the whole suite is the test.

- [ ] **Step 1: Rename the type and its alias**

In `src/main/sessions/manager.ts`, rename `interface TabRecord` to
`interface PaneRecord` and add:

```ts
/**
 * The old name for a pane record.
 *
 * A "tab" used to be exactly one tmux session with one pane, so this type
 * described both. Since M2c a tab is a session *group* and this describes one
 * pane inside it. Kept as an alias only while callers migrate; new code uses
 * `PaneRecord`.
 *
 * `PRCLI_TAB_ID` deliberately keeps its name though it identifies a pane: it is
 * on the wire, baked into the reporter script and into `settings.json`, and
 * renaming it would take every live Claude session's status dark until each was
 * restarted.
 */
export type TabRecord = PaneRecord
```

- [ ] **Step 2: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS, 506 tests, unchanged. The alias means nothing else moves yet.

- [ ] **Step 3: Migrate call sites**

Replace `TabRecord` with `PaneRecord` in `store.ts`, `restore.ts` and
`register.ts`, then delete the alias from `manager.ts`.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS, 506 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Call a pane record a pane record"
```

---

### Task 5: A tab can grow a second pane

**Files:**
- Modify: `src/main/sessions/manager.ts`, `src/main/pty/session.ts`
- Test: `tests/integration/manager.test.ts`

**Interfaces:**
- Consumes: `deathHookCommand({ reporter, tabId, tmuxSession, windowId })` (Task 1); `adapter.windowIdOf`, `adapter.selectWindow`, `adapter.resizeWindow`, `adapter.setWindowHook`, `adapter.setSessionOption` (Task 2).
- Produces on `SessionManager`:
  - `splitTab(input: { paneId: string; cwd?: string; command?: string; type?: TabType; cols?: number; rows?: number }): Promise<PaneRecord>` — adds a pane to the tab containing `paneId` and returns the new pane's record.
  - `groupNameOf(paneId: string): Promise<string>` — the tab's group name, or the pane's own session name when it is still a group of one.
- `PtySession` gains `windowId?: string` and `bindWindow?: boolean` options.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/manager.test.ts`:

```ts
describe('SessionManager.splitTab', () => {
  it('adds a pane with its own session, window and tab id', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const first = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, first.id, /\$|%|#/)

    const second = await manager.splitTab({ paneId: first.id })

    expect(second.id).not.toBe(first.id)
    expect(second.tmuxSession).toBe(`prcli-lumio-${second.id}`)
    // Both panes are members of one group, so one tab holds them both.
    const rows = await adapter.listSessionsWithGroups()
    const group = rows.find((row) => row.name === first.tmuxSession)?.group
    expect(group).toBeTruthy()
    expect(rows.find((row) => row.name === second.tmuxSession)?.group).toBe(group)
    // And each pane's process carries its OWN id, not the founder's.
    await expect
      .poll(() => sessionEnv(second.tmuxSession, 'PRCLI_TAB_ID'), { timeout: 10_000 })
      .toBe(`PRCLI_TAB_ID=${second.id}`)
    await expect
      .poll(() => sessionEnv(first.tmuxSession, 'PRCLI_TAB_ID'), { timeout: 10_000 })
      .toBe(`PRCLI_TAB_ID=${first.id}`)
    manager.detachAll()
  })

  // Bind before attach. A newly joined member's current window is arbitrary —
  // measured @0 every time — so attaching first gives the new client a
  // SIBLING's window and, under any non-manual sizing, resizes it. This is the
  // 80x24 geometry defect class in a new disguise.
  it('binds the new member to its own window, at its own size', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const first = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30 })
    await waitFor(manager, first.id, /\$|%|#/)

    const second = await manager.splitTab({ paneId: first.id, cols: 200, rows: 50 })
    await waitFor(manager, second.id, /\$|%|#/)

    await expect.poll(() => windowSize(first.tmuxSession), { timeout: 8000 }).toBe('100x30')
    await expect.poll(() => windowSize(second.tmuxSession), { timeout: 8000 }).toBe('200x50')
    manager.detachAll()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/manager.test.ts -t splitTab`
Expected: FAIL — `splitTab` is not a function.

- [ ] **Step 3: Implement `splitTab`**

In `src/main/sessions/manager.ts`:

```ts
  /**
   * The tmux group this pane's tab is, or the pane's own session name when the
   * tab is still a group of one.
   *
   * An ungrouped session reports an empty `session_group` (measured), which is
   * the ordinary state of every tab that has never been split — not an error.
   * `new-session -t <name>` accepts a session name or a group name, so the
   * founder's own name is the right thing to hand it either way.
   */
  async groupNameOf(paneId: string): Promise<string> {
    const record = this.entries.get(paneId)?.record
    if (!record) throw new Error(`groupNameOf: no pane ${paneId}`)
    const rows = await this.adapter.listSessionsWithGroups()
    const row = rows.find((candidate) => candidate.name === record.tmuxSession)
    return row?.group || record.tmuxSession
  }

  /**
   * Add a pane to the tab that already holds `paneId`.
   *
   * Three tmux objects, in this order and no other:
   *   1. `new-window -e PRCLI_TAB_ID=<new id>` in the group — holds the process.
   *   2. `new-session -t <group> -s <new name>` — the view the xterm attaches to.
   *   3. `select-window` binding 2 to 1, BEFORE any client attaches.
   *
   * Step 3 before the attach is not stylistic. A newly joined member's current
   * window is arbitrary, so a client attaching first lands on a sibling's window
   * and resizes it.
   */
  async splitTab(input: {
    paneId: string
    cwd?: string
    command?: string
    type?: TabType
    cols?: number
    rows?: number
  }): Promise<PaneRecord> {
    const sibling = this.entries.get(input.paneId)
    if (!sibling) throw new Error(`splitTab: no pane ${input.paneId}`)

    const group = await this.groupNameOf(input.paneId)
    const id = newSessionId()
    const cwd = input.cwd ?? sibling.record.cwd
    const tmuxSession = encodeSessionName({
      projectSlug: sibling.record.projectSlug,
      id,
    })

    // Sizing is explicit rather than left to `window-size latest`, which fixes
    // a window's size when a client BEGINS viewing it and did not re-size on a
    // later select-window.
    //
    // Set on each member by name, never once on the group: two probes disagreed
    // about whether this option propagates between members, and a setting that
    // happens to propagate is not a setting that was made. The group name is
    // also not a valid option target once the founder has gone.
    await this.adapter.setSessionOption(sibling.record.tmuxSession, 'window-size', 'manual')

    // The new window is created through a LIVE member, not the group name.
    const window = await this.adapter.newWindow({
      member: sibling.record.tmuxSession,
      cwd,
      command: input.command,
      env: { PRCLI_TAB_ID: id },
    })
    await this.adapter.newGroupMember(group, tmuxSession)
    await this.adapter.setSessionOption(tmuxSession, 'window-size', 'manual')
    // By index, with the member named. See the adapter method's comment.
    await this.adapter.selectWindow(tmuxSession, window.index)

    const record: PaneRecord = {
      id,
      projectSlug: sibling.record.projectSlug,
      cwd,
      command: input.command,
      tmuxSession,
      type: input.type ?? 'shell',
    }
    return this.attach(record, {
      cols: input.cols ?? DEFAULT_COLS,
      rows: input.rows ?? DEFAULT_ROWS,
      windowId: window.id,
    })
  }
```

Extract the body of `open()` from `const session = new PtySession(...)` onward
into a private `attach(record, { cols, rows, windowId })` that both `open()` and
`splitTab()` call, so the data/exit listener wiring exists once. `open()` passes
no `windowId`; it keeps today's `new-session -A` path unchanged.

Add the two adapter methods this uses, beside those from Task 2:

```ts
  /**
   * A new window in the group, holding one pane. Returns its window id.
   *
   * `-P -F '#{window_id}'` is what makes the id knowable here: the death hook
   * needs it as a literal, because tmux does not expand formats in a command
   * argument outside `run-shell`.
   */
  async newWindow(input: {
    /** A LIVE member session, never the group name — see Global Constraints. */
    member: string
    cwd: string
    command?: string
    env?: Record<string, string>
  }): Promise<{ id: string; index: string }> {
    const args = [
      'new-window', '-d', '-P', '-F', '#{window_id} #{window_index}',
      '-t', `=${input.member}:`, '-c', input.cwd,
    ]
    for (const [key, value] of Object.entries(input.env ?? {})) {
      args.push('-e', `${key}=${value}`)
    }
    if (input.command) args.push(input.command)
    const [id, index] = (await this.exec(args)).trim().split(' ')
    return { id, index }
  }

  /** Join `name` to `group` as a new view onto its shared window list. */
  async newGroupMember(group: string, name: string): Promise<void> {
    await this.exec(['new-session', '-d', '-t', group, '-s', name])
  }
```

In `src/main/pty/session.ts`, add `windowId?: string` to `PtySessionOptions`.
When it is set, `start()` attaches to an existing member rather than creating a
session: replace the `new-session -A` args with
`['attach-session', '-t', `=${this.options.tmuxSession}`]`, keep the chained
`set-option status off`, and install the hook with
`set-hook -w -t <windowId>` rather than `set-hook pane-died`. Pass `windowId`
into `deathHookCommand`. On the `open()` path `windowId` is resolved after the
session exists — see Task 6 for the one-pane case.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/integration/manager.test.ts -t splitTab`
Expected: PASS.

- [ ] **Step 5: A/B the binding assertion**

Move the `selectWindow` call to *after* `attach(...)`, re-run the second test,
and confirm the sizes come back wrong. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/main/sessions/manager.ts src/main/pty/session.ts src/main/tmux/adapter.ts tests/integration/manager.test.ts
git commit -m "Let a tab grow a second pane"
```

---

### Task 6: The blocker — a crashed pane leaves its siblings running

This is the task the milestone exists to unblock. It must fail against the
pre-Task-1 hook.

**Files:**
- Modify: `src/main/pty/session.ts` (one-pane window id resolution)
- Test: `tests/integration/pane-death.test.ts`

**Interfaces:**
- Consumes: `splitTab` (Task 5), the window-scoped hook (Tasks 1–2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/pane-death.test.ts`:

```ts
// The M2c blocker. Before this, the pane-died hook ended in `kill-session`,
// so one crashed split took its whole tab down with it.
it('takes down only the pane that died, not its siblings', async () => {
  const { manager: sessions, received } = await harness()

  const survivor = sessions.open({
    projectSlug: 'alpha',
    cwd: dir,
    command: 'sh -c "sleep 30"',
    type: 'preset',
  })
  await expect.poll(() => sessionExists(survivor.tmuxSession), { timeout: 10_000 }).toBe(true)

  const doomed = await sessions.splitTab({ paneId: survivor.id, command: 'sh -c "exit 3"' })

  // The dead pane reported its own status under its own id...
  await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThan(0)
  expect(received[0]).toMatchObject({ tabId: doomed.id, event: 'Exit', status: 3 })

  // ...its member session was reaped...
  await expect.poll(() => sessionExists(doomed.tmuxSession), { timeout: 10_000 }).toBe(false)

  // ...and the sibling is untouched, with a live pane.
  expect(await sessionExists(survivor.tmuxSession)).toBe(true)
  sessions.detachAll()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/pane-death.test.ts -t siblings`
Expected: FAIL.

- [ ] **Step 3: Resolve the window id on the one-pane path**

`open()` creates its session with `new-session -A` and does not know the window
id until tmux has made it. In `SessionManager.attach`, when no `windowId` was
supplied, resolve it after `session.start()` and install the hook then:

```ts
    // A tab that has never been split is a group of one, and its single pane's
    // window is only knowable after `new-session` has made it. The hook is
    // installed here rather than chained into the spawn for that reason — it
    // needs the window id as a literal.
    if (!options.windowId) {
      void (async () => {
        const windowId = await this.adapter.windowIdOf(record.tmuxSession)
        if (!windowId) return
        const command = this.options.deathReporter
          ? deathHookCommand({
              reporter: this.options.deathReporter,
              tabId: record.id,
              tmuxSession: record.tmuxSession,
              windowId,
            })
          : null
        if (!command) return
        // The two go on together or not at all: `remain-on-exit` without a hook
        // to reap turns every ordinary `exit` into a session nothing removes.
        //
        // Both are window-scoped, so a sibling pane's window is untouched by
        // either — measured: the sibling window reads the option unset.
        await this.adapter.setWindowOption(windowId, 'remain-on-exit', 'on')
        await this.adapter.setWindowHook(windowId, 'pane-died', command)
      })()
    }
```

Remove the now-superseded `remain-on-exit` / `set-hook` chaining from
`PtySession.start()`.

**Race to watch:** a command that exits before the hook is installed reports
nothing. The existing tests `reports the status its command exited with`
(`exit 3`) and `reports a clean exit as a status of zero` are precisely that
case. If either becomes flaky, the resolution must be awaited before the command
runs — open the session with no command, install the hook, then send the command
— rather than papered over with a timeout.

- [ ] **Step 4: Run the whole death suite**

Run: `npx vitest run tests/integration/pane-death.test.ts`
Expected: PASS, all seven tests, run three times to shake out the race above.

- [ ] **Step 5: A/B against the old hook**

Revert `deathHook.ts` to end in `kill-session` only, re-run, and confirm the new
test fails with the sibling gone. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/main/pty/session.ts src/main/sessions/manager.ts tests/integration/pane-death.test.ts
git commit -m "Stop one crashed split from taking its whole tab down"
```

---

### Task 7: Orphans reassemble into tabs

**Files:**
- Modify: `src/main/sessions/manager.ts:262-291`
- Test: `tests/integration/manager.test.ts`

**Interfaces:**
- Consumes: `adapter.listSessionsWithGroups` (Task 2), `tabIdFromGroupName` (Task 3).
- Produces: `findOrphanTabs(): Promise<{ tabId: string; panes: PaneRecord[] }[]>`. `findOrphans()` stays, returning the flat pane list, so nothing existing breaks.

- [ ] **Step 1: Write the failing test**

```ts
describe('SessionManager.findOrphanTabs', () => {
  it('groups a split tab\'s panes under one tab id', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const first = new SessionManager(adapter)
    const founder = first.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(first, founder.id, /\$|%|#/)
    const second = await first.splitTab({ paneId: founder.id })
    await waitFor(first, second.id, /\$|%|#/)
    first.detachAll()

    const tabs = await new SessionManager(adapter).findOrphanTabs()

    expect(tabs).toHaveLength(1)
    expect(tabs[0].tabId).toBe(founder.id)
    expect(tabs[0].panes.map((pane) => pane.id).sort()).toEqual([founder.id, second.id].sort())
  })

  it('reports a never-split session as a one-pane tab', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const first = new SessionManager(adapter)
    const only = first.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(first, only.id, /\$|%|#/)
    first.detachAll()

    const tabs = await new SessionManager(adapter).findOrphanTabs()

    expect(tabs).toEqual([
      expect.objectContaining({ tabId: only.id, panes: [expect.objectContaining({ id: only.id })] }),
    ])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/manager.test.ts -t findOrphanTabs`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
  /**
   * Orphaned panes assembled back into the tabs they belong to.
   *
   * Live tmux decides what exists, grouping included: the tab a pane belongs to
   * is its `session_group`, and an empty group means a tab that has never been
   * split. Nothing stored is consulted.
   *
   * The tab id comes from the group name's id half only. Its slug is whatever
   * the founder was called when the group was made and may be several projects
   * out of date — see `tabIdFromGroupName`.
   */
  async findOrphanTabs(): Promise<{ tabId: string; panes: PaneRecord[] }[]> {
    const panes = await this.findOrphans()
    const rows = await this.adapter.listSessionsWithGroups()
    const groupOf = new Map(rows.map((row) => [row.name, row.group]))

    const tabs = new Map<string, PaneRecord[]>()
    for (const pane of panes) {
      const group = groupOf.get(pane.tmuxSession) || pane.tmuxSession
      const tabId = tabIdFromGroupName(group) ?? pane.id
      const existing = tabs.get(tabId)
      if (existing) existing.push(pane)
      else tabs.set(tabId, [pane])
    }
    return [...tabs].map(([tabId, grouped]) => ({ tabId, panes: grouped }))
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/integration/manager.test.ts -t findOrphanTabs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/sessions/manager.ts tests/integration/manager.test.ts
git commit -m "Put an orphan's panes back into the tab they came from"
```

---

### Task 8: Moving a split tab moves every pane

Renaming one member of a split tab would split the tab across two projects,
because project membership is per member session name.

**Files:**
- Modify: `src/main/sessions/manager.ts:225-256`
- Test: `tests/integration/manager.test.ts`

**Interfaces:**
- Consumes: `findOrphanTabs` (Task 7), `groupNameOf` (Task 5).
- Produces: `moveTabToProject(tabId: string, projectSlug: string, known?: Map<string, Pick<PaneRecord, 'cwd' | 'command'>>): Promise<PaneRecord[]>`. `moveToProject` stays for the single-pane path and is implemented in terms of it.

**Partial-failure rule.** tmux refuses a rename onto a name already in use and
leaves the source untouched, so a refusal part-way leaves earlier panes renamed
and later ones not — a tab split across two projects, which is the one outcome
that must not happen. So: rename every member first, and if any rename throws,
rename the already-moved ones back before rethrowing. Only once every rename has
succeeded are clients cycled.

- [ ] **Step 1: Write the failing test**

```ts
describe('SessionManager.moveTabToProject', () => {
  it('renames every pane, and the tab still lists under the destination', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, founder.id, /\$|%|#/)
    const second = await manager.splitTab({ paneId: founder.id })
    await waitFor(manager, second.id, /\$|%|#/)

    const moved = await manager.moveTabToProject(founder.id, 'gco')

    expect(moved.map((pane) => pane.tmuxSession).sort()).toEqual(
      [`prcli-gco-${founder.id}`, `prcli-gco-${second.id}`].sort(),
    )
    // The stale-slug trap: the GROUP name still says lumio, because a group
    // name does not follow a rename. The tab must still list under gco, which
    // it does only if nothing reads the slug out of the group name.
    const group = await manager.groupNameOf(founder.id)
    expect(group).toContain('lumio')
    const tabs = await manager.findOrphanTabs()
    for (const pane of moved) expect(pane.projectSlug).toBe('gco')
    expect(tabs.every((tab) => tab.panes.every((pane) => pane.projectSlug === 'gco'))).toBe(true)
    manager.detachAll()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/manager.test.ts -t moveTabToProject`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `moveTabToProject`, which resolves the tab's panes through `findOrphanTabs`
plus its own open entries, renames each member with `adapter.renameSession`
inside a try/catch that rolls back completed renames on failure, then cycles each
pane's client with `this.detach(id)` / `this.open({...size})` exactly as
`moveToProject` does today — carrying each pane's own `cols`/`rows`, since
nothing in the renderer changes size across a move.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/integration/manager.test.ts -t moveTabToProject`
Expected: PASS.

- [ ] **Step 5: A/B the stale-slug assertion**

Change `findOrphanTabs` to take `projectSlug` from
`decodeSessionName(group).projectSlug` instead of from each pane. Re-run: the
moved tab must come back as `lumio`. Restore.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run check-deps`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/sessions/manager.ts tests/integration/manager.test.ts
git commit -m "Move every pane of a tab, or none of them"
```

---

## What plan 2 covers

Written after this plan lands, against the same spec:

1. **Config v5** — `panes[]` plus `tabs[]` with the split tree; v4→v5 migration (every v4 tab becomes a one-pane tab, losslessly); `write()`'s newer-version refusal retested.
2. **Restore reconcile** — reattach per pane, rebind member to window, prune layout leaves whose panes are gone, redistribute ratios.
3. **IPC** — `split`, `closePane`, per-pane data/exit/status channels.
4. **Renderer** — pane tree, one xterm per pane, drag-resize writing ratios, `⊞n` badge, worst-state aggregation for the tab dot and the project row.
5. **E2E** — split a tab, crash one pane, assert a red dot on it, the tab dot red by aggregation, the sibling still live.

## Self-review

**Spec coverage.** Object model → Tasks 5–7. Naming and identity → Task 3, asserted in Task 8. Geometry → Task 5. Death and the blocker → Tasks 1, 6. Finding 1 (`window_panes` counts dead panes) → not needed; the model gives one pane per window, recorded in the spec so nobody reaches for it. Finding 2 (member falls back to a sibling's window) → Task 1's ordering test. Finding 3 (bind before attach) → Task 5's A/B. Finding 4 (colon rule) → Global Constraints, exercised throughout Task 2. Config v5, restore, IPC, renderer, `⊞n`, aggregation → plan 2, listed above.

**Pre-flight scan (2026-07-31), five defects found in this plan and fixed before dispatch.** All measured on `-L prcli-test`: `selectWindow`'s doubled `-t` was a silent no-op that exits 0 and binds nothing; `newWindow` had to return the window index as well as its id, because binding needs the index; `remain-on-exit` moved to a window option so siblings are untouched; the claim that options propagate between group members was contradicted by a second probe and is now forbidden to rely on; and a group name stops being a valid option target once its founder dies, so it is used for `new-session -t` only. Every one of these would have produced a passing-looking command that did nothing.

**Known soft spots, stated rather than hidden.**
- Task 6 moves hook installation off the spawn and onto an async resolution, which introduces a genuine race with a fast-exiting command. The task names the two existing tests that cover it and the fix if they go flaky, rather than assuming they won't.
- `moveToProject`'s rollback is specified as a rule and a test but not as literal code; it is the one place in this plan where the implementer writes the body from a stated contract.
