# M2c Plan 2a — Persistence and Reconcile

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make splits survive a relaunch, and close the seven headless gaps plan 1's reviews left behind.

**Architecture:** Config goes to v5: a flat `panes[]` plus a `tabs[]` whose layout is one axis of pane ids with a ratio each. Restore reattaches every pane, binds each member session to its own window, **sizes that window explicitly** — plan 1 was relying on tmux's `latest` mode to do that, and it no longer applies — and prunes layout entries whose panes are gone.

**Tech Stack:** TypeScript, Electron main process, node-pty, real tmux 3.7b via `TmuxAdapter`, Vitest (`npm test`).

**Scope:** Plan 2a of 2b. Headless only — config, reconcile, session lifecycle. IPC, the renderer pane tree, drag-resize and E2E are plan 2b. This plan is testable on its own: at the end, a split tab reopens as a split tab after a relaunch, with each pane at the right size.

**Spec:** `docs/superpowers/specs/2026-07-31-prcli-m2c-splits-design.md` — see §Config v5, §Plan 2 rulings.
**Reviews this plan discharges:** `docs/superpowers/reviews/2026-07-31-prcli-m2c-core-branch-review.md` and `…-rereview.md`.

## Global Constraints

- Tests use `-L prcli-test` only, via `new TmuxAdapter({ socket: 'prcli-test' })`. **Never the default socket.** `tmux -L prcli-test kill-server` is the established teardown; a bare `kill-server` is forbidden.
- Tests never touch the real `~/.prcli` (`PRCLI_CONFIG_DIR`), `~/Code` (`PRCLI_PROJECTS_ROOT`), or `~/.claude/settings.json` (`PRCLI_CLAUDE_SETTINGS`) — the last is read by roughly twelve live Claude sessions.
- **Never run `npm install` / `npm ci`.** It breaks node-pty's spawn-helper permissions and fails every integration test with `posix_spawnp failed`.
- **Never weaken, delete or loosen a test assertion, timeout or poll interval to make something pass.** If an assertion contradicts the code, stop and report.
- **Never assert over a collection without first asserting it is non-empty.** `[].every(...)` and `for (const x of [])` both pass silently. This produced a test that could not fail in plan 1.
- **Assert on state read back from tmux, never on an exit code.** Every defect in plan 1 was a command that exits 0 and does nothing.
- Target syntax: `=name` for session targets (`has-session`, `kill-session`, `rename-session`, `list-clients`); `=name:` **with** trailing colon for window/pane-scoped (`set-option`, `show-options`, `display-message`, `list-panes`, `new-window`); a bare `@7` for a window id.
- `window-size` is a **window** option. `set-option -t '=name:'` on it resolves to that session's *current* window. Set it with `-w` against a window id.
- **`resize-window` itself flips a window to `manual`.** So `latest` — which was invisibly carrying pane geometry onto the window on every attach — stops applying after the first renderer resize. Any path that attaches must size the window itself.
- `remain-on-exit` and the `pane-died` hook go on together or not at all. The option with no hook creates a stray tmux session; this project has shipped that once.
- A pane's project comes from its own session name. A group name's slug is frozen at creation and must **never** be read; only its 16-hex id may be, via `tabIdFromGroupName`.
- `PRCLI_TAB_ID` keeps its name though it identifies a pane.
- Comments explain *why*, citing what was measured. **A comment asserting a mechanism that is not true is a defect here** — four were found in plan 1.
- A/B every load-bearing assertion by breaking the production code it guards and watching that exact test fail. **Before committing, `git diff` on production files must be empty of the mutation.** Ten tests that could not fail have been found on this project; a green suite caught none of them.

---

### Task 1: `awaitWindowId` stops meaning three things

**Files:**
- Modify: `src/main/sessions/manager.ts` (`awaitWindowId`, `wireDeathHook`), `src/main/tmux/adapter.ts` (`windowIdOf`)
- Test: `tests/integration/manager.test.ts`, `tests/integration/session.test.ts`

**Interfaces:**
- Produces: `type WindowLookup = { kind: 'found'; id: string } | { kind: 'gone' } | { kind: 'unreachable' }`, exported from `src/main/tmux/adapter.ts`. `TmuxAdapter.lookupWindow(session: string): Promise<WindowLookup>` replaces `windowIdOf` at its call sites; keep `windowIdOf` only if something still needs a bare string, otherwise delete it.

Today `windowIdOf` swallows every failure and answers `''`, so "tmux says no such session" and "tmux would not answer" are indistinguishable — and a tab can end up with neither `remain-on-exit` nor a hook while nothing reports it. The plan-1 fix wave documented this rather than fixing it.

- [ ] **Step 1: Write the failing tests**

```ts
it('reports a session tmux has never heard of as gone, not as unreachable', async () => {
  const adapter = new TmuxAdapter({ socket: SOCKET })
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'real', 'sleep', '600'])
  expect(await adapter.lookupWindow('nosuchsession')).toEqual({ kind: 'gone' })
})

it('reports a window it can name as found', async () => {
  const adapter = new TmuxAdapter({ socket: SOCKET })
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'real', 'sleep', '600'])
  expect(await adapter.lookupWindow('real')).toMatchObject({ kind: 'found' })
})

// The distinction the whole task exists for. A tmux that cannot be run at all
// is not a session that has gone, and must not be reported as one.
it('reports a tmux it cannot run as unreachable, not as gone', async () => {
  const adapter = new TmuxAdapter({ socket: SOCKET, bin: '/nonexistent/tmux' })
  await expect(adapter.lookupWindow('anything')).rejects.toThrow(TmuxNotInstalledError)
})
```

For the third case decide deliberately and say which you chose in your report: `TmuxNotInstalledError` already throws out of `exec`, so an absent binary is arguably not `unreachable` but a hard error. `unreachable` is for tmux answering with something that is neither success nor "can't find session" — e.g. a wedged server. If you cannot provoke that reliably on this machine, test it by stubbing `exec` and say so.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/integration/adapter.test.ts -t lookupWindow`
Expected: FAIL — `lookupWindow` is not a function.

- [ ] **Step 3: Implement**

`lookupWindow` distinguishes the cases `windowIdOf` collapsed. Reuse the existing `isNoSuchSession` / `isNoServer` / `stderrOf` helpers — do not re-implement them. A session that is genuinely gone is `gone`; anything else that is not a successful name is `unreachable`.

Then thread it through: `awaitWindowId` returns `WindowLookup`, polling only while the answer is `gone` **and** the deadline has not passed (a session being created has not appeared yet, which reads as `gone`). `wireDeathHook` installs on `found`, returns silently on `gone` — nothing to hook and nothing to leak — and on `unreachable` logs one line saying the pane will show grey instead of red, because that is the honest consequence.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/integration/adapter.test.ts tests/integration/manager.test.ts tests/integration/session.test.ts`

- [ ] **Step 5: A/B**

Make `lookupWindow` return `{ kind: 'gone' }` for the unreachable case — the exact conflation this task removes — and confirm a test fails. Restore, and confirm `git diff` on `src/` is empty.

- [ ] **Step 6: Commit**

```bash
git add src/main/tmux/adapter.ts src/main/sessions/manager.ts tests/
git commit -m "Stop one empty string meaning gone, unreachable and not yet"
```

---

### Task 2: `canBuildDeathHook` takes `isPrcliSession`

**Files:**
- Modify: `src/main/pty/deathHook.ts`
- Test: `tests/unit/deathHook.test.ts`

`canBuildDeathHook` and `deathHookCommand` check the session name against `UNSAFE_IN_HOOK`, the charset built for the *reporter path*. The two land in different contexts: the reporter sits inside `run-shell "…"` where `;` and spaces are inert; the session name does not — it lands in `kill-session -t =<name> ; kill-window -t @7`, so a `;` in a name would end the command early. Widening the shared charset is the wrong fix: the reporter legitimately contains spaces and a test says so.

Unreachable today, because every name comes from `encodeSessionName`. This makes that guarantee explicit instead of incidental.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses a session name that is not one this app could have generated', () => {
  for (const tmuxSession of [
    'prcli-alpha-a1b2c3d4e5f60718 ; kill-server',
    'prcli-alpha-nothex',
    'not-a-prcli-name',
    '',
  ]) {
    expect(
      deathHookCommand({
        reporter: '/tmp/prcli/prcli-hook',
        tabId: 'a1b2c3d4e5f60718',
        tmuxSession,
        windowId: '@7',
      }),
    ).toBeNull()
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL on the `; kill-server` case, which the current charset accepts.

- [ ] **Step 3: Implement**

Replace the session-name arm of the guard with `isPrcliSession(input.tmuxSession)` (from `../tmux/names`) in both `deathHookCommand` and `canBuildDeathHook`. Leave the reporter's `UNSAFE_IN_HOOK` check exactly as it is — it guards a different string in a different context, and the existing "keeps a path with a space in it as one word" test must still pass. Say in the comment why the two differ.

- [ ] **Step 4: Run** — `npx vitest run tests/unit/deathHook.test.ts`, then full `npm test`.

- [ ] **Step 5: A/B** — revert to the charset check and confirm the `; kill-server` case fails. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Let only a name this app could have generated into a hook"`

---

### Task 3: `kill()` reaps the window too

**Files:**
- Modify: `src/main/sessions/manager.ts` (`kill`)
- Test: `tests/integration/manager.test.ts`

`kill()` destroys a member session but never its window. For a one-pane tab the window dies with the last member, so this has never shown. For a split it leaks a window **and the process inside it** — a running command with no session and no UI.

- [ ] **Step 1: Write the failing test**

```ts
it('kills one pane of a split without leaving its window or its process behind', async () => {
  const adapter = new TmuxAdapter({ socket: SOCKET })
  const manager = new SessionManager(adapter)
  const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
  await waitFor(manager, founder.id, /\$|%|#/)
  const second = await manager.splitTab({ paneId: founder.id, command: 'sleep 600' })
  await waitFor(manager, second.id, /\$|%|#/)
  const windows = await windowsIn(founder.tmuxSession)
  expect(windows).toHaveLength(2)

  await manager.kill(second.id)

  expect(await sessionExists(second.tmuxSession)).toBe(false)
  // The window, and so the process in it, must be gone too.
  await expect.poll(() => windowsIn(founder.tmuxSession), { timeout: 10_000 }).toHaveLength(1)
  expect(await sessionExists(founder.tmuxSession)).toBe(true)
})
```

`windowsIn` already exists in this file from plan 1 — reuse it, do not write a second one.

- [ ] **Step 2: Run to verify it fails** — expected: two windows remain.

- [ ] **Step 3: Implement**

Resolve the pane's window **before** killing its session (afterwards there is no session to ask), then kill session then window — the same order the death hook uses, and for the same reason: a member whose window dies first falls back to a sibling's window. `killWindow` already tolerates an already-gone window, which covers the one-pane case where the session's death took the window with it.

- [ ] **Step 4: Run** — the file, then full `npm test`.

- [ ] **Step 5: A/B** — remove the `killWindow` call, confirm the new test fails with two windows. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Take the window with the pane, not just its session"`

---

### Task 4: A rename cycle never leaves a stale hook

**Files:**
- Modify: `src/main/sessions/manager.ts` (`moveTabToProject`)
- Test: `tests/integration/manager.test.ts`

Plan 1 narrowed this: hooks are reinstalled before any client is cycled. The residue the re-review named is that a pane dying *between* two renames still meets a hook naming the old session, so its reap targets a name that no longer exists.

- [ ] **Step 1: Write the failing test**

Split a tab, then move it, and assert that after the move **every** pane's window carries a hook naming its *current* session — read it back with `show-hooks -w -t <window>` and assert the new slug appears and the old one does not. Assert the pane list is non-empty first.

Then the harder half: kill one pane's process mid-move. If you cannot make that deterministic, say so and instead assert the invariant directly — that no window's installed hook names a session that no longer exists — which is the property the residue violates. Report which you did.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

Reinstall each pane's hook **inside** the rename loop, immediately after that pane's rename, so the window between a rename and its hook is as small as tmux allows. The rollback must restore hooks too: a pane renamed back to its old name with a hook naming the new one is the same defect mirrored.

- [ ] **Step 4: Run** — the file, then full `npm test`.

- [ ] **Step 5: A/B** — move the reinstall back outside the loop; confirm the test fails. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Reinstall a pane's hook with its rename, not after all of them"`

---

### Task 5: Attach sizes the window

**Files:**
- Modify: `src/main/sessions/manager.ts` (`attach`)
- Test: `tests/integration/manager.test.ts`

**This is the task most likely to prevent a shipped defect.** `resize-window` flips a window to `window-size manual`, so after the first renderer resize a window no longer follows its client. `latest` had been carrying pane geometry onto the window on every attach, invisibly. `attach` issues no `resize-window` at all, so the first caller that attaches to a window it did not just size gets whatever size that window last had. That caller is Task 7's restore.

The spec has always said the window is sized "on attach **and** on every renderer resize". Only the second half exists.

- [ ] **Step 1: Write the failing test**

```ts
// The window must end up at the size the CLIENT was given, whatever size the
// window happened to be beforehand. Under `manual` it will not follow on its
// own, and `latest` is no longer reliable once anything has called resize-window.
it('sizes the window to the client on every attach, not only the first', async () => {
  const adapter = new TmuxAdapter({ socket: SOCKET })
  const manager = new SessionManager(adapter)
  const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30 })
  await waitFor(manager, tab.id, /\$|%|#/)
  // Force the window to `manual` at a different size, exactly as a renderer
  // resize would, then drop the client.
  manager.resize(tab.id, 140, 45)
  await expect.poll(() => windowSize(tab.tmuxSession), { timeout: 8000 }).toBe('140x45')
  manager.detach(tab.id)

  // Reattach at a third size. Nothing else will correct this.
  const again = manager.open({
    id: tab.id, projectSlug: 'lumio', cwd: tmpdir(),
    tmuxSession: tab.tmuxSession, type: tab.type, cols: 120, rows: 40,
  })
  await waitFor(manager, again.id, /\$|%|#/)

  await expect.poll(() => windowSize(tab.tmuxSession), { timeout: 8000 }).toBe('120x40')
  manager.detachAll()
})
```

- [ ] **Step 2: Run to verify it fails** — expected: the window stays at `140x45`.

- [ ] **Step 3: Implement**

In `attach`, after the client exists and its window is known, `resize-window` that window to the entry's `cols`/`rows`. On the `splitTab` path the window id is already in hand; on the `open` path it comes from Task 1's `lookupWindow`, and a `gone`/`unreachable` answer means skip — never guess a window id.

Say in the comment *why* this is here: `resize-window` makes windows `manual`, so nothing else will do it, and this is the third disguise of a defect that has shipped twice.

- [ ] **Step 4: Run** — the file, then full `npm test`, three times (this touches every attach path).

- [ ] **Step 5: A/B** — remove the `resize-window` call and confirm the new test fails. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Size a window when a client attaches to it"`

---

### Task 6: Config v5

**Files:**
- Modify: `src/main/state/store.ts`
- Test: `tests/unit/store.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TabLayout {
  /** One axis per tab — never a tree. Ruled 2026-07-31; see the spec. */
  dir: 'row' | 'col'
  /** One entry per pane id in `kids`, summing to 1. */
  ratio: number[]
  kids: string[]
}
export interface TabRow {
  /** The founder pane's id. Stable across a move; the group name is not stored. */
  id: string
  activePaneId: string | null
  layout: TabLayout
}
export interface PrcliConfig {
  version: 5
  projects: ProjectRecord[]
  activeProjectId: string | null
  panes: PaneRecord[]
  tabs: TabRow[]
  notifications: NotificationConfig
}
```

- [ ] **Step 1: Write the failing tests**

Cover: a v4 file migrating losslessly — every v4 `tabs[]` row becomes one `panes[]` row **and** a one-pane `tabs[]` row whose `layout` is `{dir:'row', ratio:[1], kids:[thatPaneId]}`, with `id` equal to that pane's id; a v5 file round-tripping; a **v6** file returning empty (refusing to guess at a future shape); `write()` still refusing to overwrite a newer version on disk; and a malformed `layout` being normalised away rather than throwing, since `read()` never throws.

Assert the v4 case pane-by-pane, and assert the tab count first — a `for` loop over an empty `tabs[]` would pass whatever the migration did.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

Add the v5 branch and a v4→v5 migration. Keep every existing v1/v2/v3 branch working — they migrate to v4's shape and then through the same v4→v5 step, rather than each growing its own copy. `EMPTY` becomes v5. A row whose `layout.kids` references a pane id not in `panes[]` is dropped from the layout, and a tab left with no kids is dropped entirely.

- [ ] **Step 4: Run** — `npx vitest run tests/unit/store.test.ts`, then full `npm test`. `restore.ts` writes `version: 4` today and will not compile; fixing that is Task 7 — if you need the tree green to commit, have `restore.ts` write the migrated v5 of what it already builds and leave the reconcile itself alone.

- [ ] **Step 5: A/B** — make the v4→v5 migration drop `activePaneId`, confirm a test fails. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Take config to v5, with a tab that can hold more than one pane"`

---

### Task 7: Restore reconciles panes and tabs

**Files:**
- Modify: `src/main/ipc/restore.ts`
- Test: `tests/integration/restore.test.ts`

**Interfaces:**
- Consumes: `manager.findOrphanTabs()` (plan 1), `panesOfTab`, Task 5's sizing attach, Task 6's v5 shape.

- [ ] **Step 1: Write the failing tests**

The load-bearing one: open a tab, split it, write config, then reconcile with a fresh manager and assert **both** panes come back, grouped under one tab, with the saved `dir` and `ratio` intact and each pane's window at its saved size. Assert lengths before iterating.

Then the pruning cases: a layout leaf whose pane's session is gone is removed and **its ratio redistributed so the rest still sum to 1** (assert the sum, not just the length); a tab whose panes have all gone is dropped; a pane tmux has that config never knew about still appears, as a one-pane tab, exactly as an adopted session does today.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

Keep everything the current `restoreWorkspace` doc comment promises — it encodes decisions that cost real defects: the `detachAll()` before `findOrphans` (without it a second restore in one app lifetime strands every session), the saved row's `cwd`/`command`/`type` winning over the orphan's synthesised ones, one failed attach not costing the others, and the whole reconcile running inside the caller's `serialise` queue with nothing inside it calling `serialise` again.

What changes: panes are reattached per pane rather than per tab; tabs are rebuilt from `findOrphanTabs`, with layout taken from config where a saved tab matches and synthesised as a one-pane row where it does not; and each member is bound to its window before its client attaches.

- [ ] **Step 4: Run** — `npx vitest run tests/integration/restore.test.ts`, then full `npm test` three times.

- [ ] **Step 5: A/B** — twice. Skip the ratio redistribution and confirm a test catches ratios not summing to 1; then remove the bind-before-attach and confirm a test catches it. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Bring a split tab back as a split tab"`

---

### Task 8: The IPC move handles a split tab

**Files:**
- Modify: `src/main/ipc/register.ts` (the `moveTabToProject` handler)
- Test: `tests/integration/restore.test.ts` or a new `tests/integration/register.test.ts`, whichever fits the existing layout

`register.ts` still calls the **singular** `manager.moveToProject`. Unreachable today because no IPC exposes splitting — and it becomes a live "tab split across two projects" bug the moment plan 2b adds a split command. Fixing it before that command exists is the whole point.

- [ ] **Step 1: Write the failing test**

Drive the handler (or the function it delegates to) for a split tab and assert **every** pane's session carries the destination slug. Assert the pane count first.

- [ ] **Step 2: Run to verify it fails** — expected: one pane moved, one left behind.

- [ ] **Step 3: Implement**

Call `moveTabToProject` and return the whole pane list. The handler's existing `saved` lookup passes one row's `cwd`/`command`; it now needs the per-pane map `moveTabToProject` takes, built from the config rows for that tab's panes.

- [ ] **Step 4: Run** — the file, then full `npm test`, then `npm run typecheck` and `npm run check-deps`.

- [ ] **Step 5: A/B** — put the singular call back and confirm the test fails with a pane stranded in the source project. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Move every pane of a tab from the UI path too"`

---

## Deliberately not in this plan

- **Cancellation for `awaitWindowId`.** Task 1 unblocks it by giving `''` one meaning, but the poll is not a live defect — it ends after 10 s and its result is swallowed. Plan 2b or later.
- **Coalescing `resize()`'s per-resize `execFile`.** Wait until 2b's drag-resize shows whether it is chatty; guessing now optimises nothing.
- **Arbitrary pane nesting.** Ruled out for now; see the spec. The tmux model does not care, so this stays a renderer and config change whenever it happens.

## Self-review

**Spec coverage.** §Config v5 → Tasks 6, 7. §Plan 2 rulings `WindowLookup` → Task 1; layout one axis → Task 6; drag writes on mouse-up → plan 2b. Carry list: item 1 → Task 5, item 2 → Task 3, item 3 → Task 4, item 4 → Task 1, item 5 → Task 2, item 6 → deferred above, item 7 → deferred above, item 8 → Task 8.

**Ordering.** Task 1 precedes Task 5 because the sizing attach needs a window id it can trust. Task 6 precedes Task 7 because the reconcile writes the v5 shape. Task 3 is independent. Task 8 last because it is the only one touching IPC.

**Known soft spots, stated rather than hidden.**
- Task 1's `unreachable` case may not be provokable with a real tmux on this machine; the task says to stub and report rather than skip it silently.
- Task 4's mid-move death may not be deterministic; the task names the invariant to assert instead, and requires saying which route was taken.
- Task 6 knowingly breaks `restore.ts`'s compile between Tasks 6 and 7; the task says so and gives the minimal bridge rather than leaving an implementer to discover it.
