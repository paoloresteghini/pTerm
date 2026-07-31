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
- Test: `tests/integration/adapter.test.ts`, `tests/integration/manager.test.ts`, `tests/integration/session.test.ts`

**Interfaces:**
- Produces: `type WindowLookup = { kind: 'found'; id: string } | { kind: 'gone' } | { kind: 'unreachable' }`, exported from `src/main/tmux/adapter.ts`. `TmuxAdapter.lookupWindow(session: string): Promise<WindowLookup>` replaces `windowIdOf` at its call sites; keep `windowIdOf` only if something still needs a bare string, otherwise delete it.

Today `windowIdOf` swallows every failure and answers `''`, so "tmux says no such session" and "tmux would not answer" are indistinguishable — and a tab can end up with neither `remain-on-exit` nor a hook while nothing reports it. The plan-1 fix wave documented this rather than fixing it.

- [ ] **Step 1: Write the failing tests**

Put all three inside `describe('TmuxAdapter.lookupWindow', …)`, matching the
`describe('TmuxAdapter.<method>')` convention the file already uses. That is not
cosmetic: Step 2 filters by name, and a `-t` that matches nothing **exits 0**.
Measured on this repo just now — `npx vitest run tests/unit/names.test.ts -t
lookupWindow` reported `Tests 16 skipped` and `EXIT=0`. A green Step 2 with no
`describe` to match would be a verification that cannot fail.

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
Expected: FAIL — `lookupWindow` is not a function. **Read the test count, not the
exit code.** `Tests 3 failed` is the expected outcome; `Tests N skipped` with
exit 0 means the filter matched nothing and you have verified nothing.

- [ ] **Step 3: Implement**

`lookupWindow` distinguishes the cases `windowIdOf` collapsed.

**The measurement that decides this, taken on tmux 3.7b during pre-flight:** a
`display-message` naming a session that does not exist **succeeds**. It does not
raise anything for `isNoSuchSession` to recognise.

```
$ tmux -L probe display-message -p -t '=nosuchsession:' '#{window_id}'
                          # one blank line
exit=0
$ tmux -L nosuchsocket display-message -p -t '=nosuch:' '#{window_id}'
error connecting to /private/tmp/tmux-501/nosuchsocket (No such file or directory)
exit=1
```

So the branch order is:

1. The call **succeeded and named a window** → `found`.
2. The call **succeeded and returned empty** → `gone`. This is the ordinary
   case — a session tmux has never heard of, and also a session `open()` has
   asked for before tmux has finished making it. It arrives as success, so no
   error helper will ever see it.
3. The call **failed** with `isNoSuchSession` / `isNoServer` (no server at all)
   → `gone`.
4. Anything else that failed → `unreachable`.

Reuse `isNoSuchSession` / `isNoServer` / `stderrOf` for 3 and 4 — do not
re-implement them. Getting 2 wrong is the whole risk in this task: route
empty-on-success to `unreachable` and `awaitWindowId`, which polls only while
the answer is `gone`, returns on its first tick for **every** founder pane. Every
tab then loses its `pane-died` hook and never has `remain-on-exit` taken back
off — grey dots everywhere and a stray session per exit, with nothing failing
loudly. Candidate reading, not a mandate: if you measure something that
contradicts the table above, say so and follow the measurement.

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

Expected: FAIL on **all four** cases. `UNSAFE_IN_HOOK` covers only quote, double
quote, dollar, backtick, backslash, newline and hash. It contains neither `;`
nor a space, so the injection case, the non-hex case, the
non-prcli case and the empty string all pass today's guard and all four come
back non-null.

- [ ] **Step 3: Implement**

Replace the session-name arm of the guard with `isPrcliSession(input.tmuxSession)` (from `../tmux/names`). There is exactly one such arm, `canBuildDeathHook`'s line 45 — `deathHookCommand` has no session check of its own, it delegates. Leave the reporter's `UNSAFE_IN_HOOK` check exactly as it is — it guards a different string in a different context, and the existing "keeps a path with a space in it as one word" test must still pass. Say in the comment why the two differ.

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
  // Deliberately NO `waitFor` on `second`. Measured during pre-flight: a client
  // attached to a pane running `sleep 600` emits 791 bytes of screen setup and
  // not one `$`, `%` or `#`, so waiting for a prompt here times out at 8s and
  // throws — the test could never pass. There is nothing left to wait for
  // either: `splitTab` has already awaited every tmux call it makes.
  const windows = await windowsIn(founder.tmuxSession)
  expect(windows).toHaveLength(2)
  // Read before the kill — afterwards there is no pane left to ask.
  const pid = await panePid(second.tmuxSession)
  expect(pid).toMatch(/^\d+$/)

  await manager.kill(second.id)

  expect(await sessionExists(second.tmuxSession)).toBe(false)
  await expect.poll(() => windowsIn(founder.tmuxSession), { timeout: 10_000 }).toHaveLength(1)
  // The window is gone, and so is what was running inside it. Asserted on the
  // process rather than inferred from the window count, because "a running
  // command with no session and no UI" is the actual harm this task prevents.
  await expect.poll(() => isRunning(pid), { timeout: 10_000 }).toBe(false)
  expect(await sessionExists(founder.tmuxSession)).toBe(true)
})
```

`windowsIn` and `sessionExists` already exist in this file from plan 1 — reuse them, do not write second copies. `panePid` and `isRunning` do not; add them next to the other helpers. Candidates, not mandates — `display-message -p -t '=<name>:' '#{pane_pid}'` for the first (note the trailing colon: it is pane-scoped) and `process.kill(Number(pid), 0)` in a try/catch for the second. If `pane_pid` turns out to name the `sh` tmux wraps the command in rather than `sleep` itself, that is still the right thing to assert — it is the process the window owns — but say so in your report.

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

`show-hooks -w` was measured working on 3.7b during pre-flight, so this read-back is sound:

```
$ tmux -L probe show-hooks -w -t @0
pane-died[0] run-shell "echo hi"
```

(`show-options -w -t @0 -H` prints the same thing alongside the window options, if you would rather have one call.)

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

Two traps, both found in pre-flight, both of which produce a test failure that looks like something else:

- **Do not put this inside `wireDeathHook`.** It is the obvious home — the only
  place `attach` already resolves a window id — and it returns on its first line
  unless `options.deathReporter` is set. The test above builds a
  `SessionManager` with no reporter, so a sizing call placed there never runs at
  all, and the failure reads as "the resize did not work" rather than "the
  resize did not happen".
- **Route it through `resizeWindow(entry, cols, rows)`, not
  `adapter.resizeWindow` directly.** `attach` is synchronous and this call
  cannot be, so it lands some milliseconds later — after a renderer `resize()`
  has already moved the window on, if the renderer is quick. The private
  `resizeWindow` already re-checks `entry.cols`/`entry.rows` before the call
  lands, for exactly this reason; its comment calls it "last writer wins by
  accident". Bypassing it reintroduces that, and the symptom is a window that
  snaps back to its open-time size on every attach.

Say in the comment *why* this is here: `resize-window` makes windows `manual`, so nothing else will do it, and this is the third disguise of a defect that has shipped twice. Measured in pre-flight, so it can be cited as fact: a window created with `window-size` unset reads back `manual` immediately after one `resize-window -x 140 -y 45`.

- [ ] **Step 4: Run** — the file, then full `npm test`, three times (this touches every attach path).

- [ ] **Step 5: A/B** — remove the `resize-window` call and confirm the new test fails. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Size a window when a client attaches to it"`

---

### Task 6: Config v5

**Files:**
- Modify: `src/main/state/store.ts`, `src/main/ipc/register.ts`, `src/main/index.ts`
- Test: `tests/unit/store.test.ts`

This task owns **every** reader of `config.tabs`, not just the store. `tabs` keeps its name and changes meaning — from `PaneRecord[]` to `TabRow[]` — so a site that used to mean "the saved pane rows" and now compiles against tab rows is not a compile error, it is a silent behaviour change. Pre-flight found nine such sites and one that goes silent:

| Site | After the change |
| --- | --- |
| `register.ts:63` `rememberTab` | errors on `tabs.push(tab)` — a `TabDescriptor` is not a `TabRow` |
| `register.ts:71-72` `forgetTab` | **compiles clean and is wrong.** `config.tabs.filter(saved => saved.id !== id)` type-checks against `TabRow[]`, so this prunes the tab row and leaves the pane row on disk forever |
| `register.ts:284` `described` | errors — `describeProjects` wants `TabDescriptor[]` |
| `register.ts:295` `setActive` | errors on `tab.projectSlug` |
| `register.ts:375, 385-387` move handler | errors; **Task 8 owns these two**, leave them |
| `index.ts:57` `readTabs` | feeds the hook inbox — check what `createHookInbox` expects |
| `index.ts:82` `mergeTab` | feeds notification routing |
| `restore.ts:125, 173` | Task 7 owns these; the bridge below is all this task does to them |

`forgetTab` is the one that matters most, because it is the one nothing catches. Every other site above is `npm run typecheck`'s to find — run it, and treat a clean typecheck as necessary and not sufficient. Point each of these at `config.panes`; none of them wants a tab row.

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

Cover: a v4 file migrating losslessly — every v4 `tabs[]` row becomes one `panes[]` row **and** a one-pane `tabs[]` row whose `layout` is `{dir:'row', ratio:[1], kids:[thatPaneId]}`, with `id` equal to that pane's id **and `activePaneId` equal to it too**; a v5 file round-tripping; a **v6** file returning empty (refusing to guess at a future shape); `write()` still refusing to overwrite a newer version on disk; and a malformed `layout` being normalised away rather than throwing, since `read()` never throws.

`activePaneId` is called out because Step 5's A/B mutates it, and an A/B against an assertion no test makes is one of the ten that could not fail on this project. Assert it or pick a different mutation — do not leave the pair mismatched.

Assert the v4 case pane-by-pane, and assert the tab count first — a `for` loop over an empty `tabs[]` would pass whatever the migration did.

One thing v5 does not settle: `ProjectRecord.activeTabId` is resolved against pane rows today (`describeProjects` matches it against `TabDescriptor[]`), and with tabs and panes now distinct it is ambiguous which it names. Leave the behaviour as it is — resolving against panes — and say so in a comment. Changing it is a renderer-visible decision and belongs to plan 2b; what this task owes is that the ambiguity is written down rather than resolved by accident.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

Add the v5 branch and a v4→v5 migration. Keep every existing v1/v2/v3 branch working — they migrate to v4's shape and then through the same v4→v5 step, rather than each growing its own copy. `EMPTY` becomes v5. A row whose `layout.kids` references a pane id not in `panes[]` is dropped from the layout, and a tab left with no kids is dropped entirely.

- [ ] **Step 4: Run** — `npx vitest run tests/unit/store.test.ts`, then full `npm test`, then **`npm run typecheck`** — which is not optional here, it is how the table above gets closed out. `restore.ts` writes `version: 4` today and will not compile; fixing that is Task 7 — if you need the tree green to commit, have `restore.ts` write the migrated v5 of what it already builds and leave the reconcile itself alone.

- [ ] **Step 5: A/B** — twice. First, make the v4→v5 migration drop `activePaneId` and confirm a test fails. Then point `forgetTab` back at `config.tabs` and confirm a test fails — this is the site that stays green through a typecheck, so if nothing fails, it has no coverage and you owe it a test before this task is done. Restore both; `git diff` empty.

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

And one more, which replaces the bind-before-attach this task originally asked for — see Step 3: **no two live members of a tab report the same `#{window_id}`.** Assert the member list is non-empty and longer than one first, then assert the set of window ids is the same size as the member list. A pane whose window has died and whose member has silently fallen back to a sibling's is what this catches, and it is the only form of that failure restore can actually see.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

Keep everything the current `restoreWorkspace` doc comment promises — it encodes decisions that cost real defects: the `detachAll()` before `findOrphans` (without it a second restore in one app lifetime strands every session), the saved row's `cwd`/`command`/`type` winning over the orphan's synthesised ones, one failed attach not costing the others, and the whole reconcile running inside the caller's `serialise` queue with nothing inside it calling `serialise` again.

What changes: panes are reattached per pane rather than per tab; and tabs are rebuilt from `findOrphanTabs`, with layout taken from config where a saved tab matches and synthesised as a one-pane row where it does not.

**Not** "each member is bound to its window before its client attaches", which is what this plan asked for before pre-flight measured it. Two facts kill it:

```
member current window AFTER select-window:      @1 1
member current window after `new-session -A`:   @1 1     # binding is server state; it survives
member current window after its own window died: @0 0    # silent fallback to a sibling's
```

The binding is tmux server state and outlives every client, so on the restore path a `select-window` is a no-op — the app is reattaching to a server that never forgot. And restore has no stored member→window map to bind *from*: the only source available is the member's own current window, which is either already right (no-op) or the fallback shown above, in which case re-binding writes the sibling's window back and cements the two-xterms-rendering-one-pane bug rather than fixing it.

So: do not bind. Detect instead — the duplicate-`window_id` assertion in Step 1 — and prune the pane whose window is gone, the same way a pane whose session is gone is pruned. If you find a way to recover the true binding that pre-flight missed, say so and take it; this is a candidate, and the measurements above are the reason for it, not the conclusion.

Keep everything else the doc comment promises, listed above.

- [ ] **Step 4: Run** — `npx vitest run tests/integration/restore.test.ts`, then full `npm test` three times.

- [ ] **Step 5: A/B** — twice. Skip the ratio redistribution and confirm a test catches ratios not summing to 1; then make the duplicate-`window_id` prune a no-op and confirm a test catches *that*. The second one replaces "remove the bind-before-attach and confirm a test catches it", which pre-flight showed could not fail: the bind is a no-op on this path, so removing it changes nothing and the A/B passes either way. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Bring a split tab back as a split tab"`

---

### Task 8: The IPC move handles a split tab

**Files:**
- Modify: `src/main/ipc/register.ts` (the `moveTabToProject` handler)
- Test: `tests/integration/restore.test.ts` or a new `tests/integration/register.test.ts`, whichever fits the existing layout

Task 6 has already repointed every other `config.tabs` reader in this file at `config.panes`; the move handler's `saved` lookup (line 375) and its write-back (385-387) were left for this task on purpose, because they change shape rather than just name.

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
- Task 6 also owns eight `config.tabs` sites outside the store, one of which (`forgetTab`) survives a typecheck while meaning something else. Named in the task's table rather than left to the branch review.

## Pre-flight scan, 2026-07-31

Run against the code before dispatch, on the branch at 98abe0e. Eleven findings, four blocking, all folded into the tasks above. Everything below was measured on tmux 3.7b on `-L prcli-probe*` and this repo's own vitest, not reasoned about.

**Blocking.** (1) `display-message` naming a session that does not exist **exits 0 with empty stdout** — no error helper sees it — so Task 1's `gone` case has to be recognised on the success path or every founder pane silently loses its death hook. (2) Task 3's test waited for a shell prompt in a pane running `sleep 600`; measured 791 bytes emitted and no `$`, `%` or `#`, so it could never have passed. (3) Task 6's blast radius is nine sites, not one, and `forgetTab` breaks silently through a clean typecheck. (4) Task 7's bind-before-attach is a no-op on the restore path — the binding is server state that survives reattach — so its A/B could not fail; replaced with a duplicate-`window_id` invariant that can.

**Important.** (5) Task 5's sizing must not live in `wireDeathHook`, which returns early with no `deathReporter` — as the task's own test has none. (6) It must route through the private `resizeWindow` so a late attach-time resize cannot revert a renderer resize. (7) Task 1's Step 2 filter matched no test name; measured `Tests 16 skipped`, `EXIT=0` — a verification that could not fail.

**Minor.** (8) Only one session-name guard exists, not two. (9) All four of Task 2's cases fail today, not just the injection one. (10) Task 6's A/B mutated a field no test asserted. (11) `ProjectRecord.activeTabId` is ambiguous under v5 and is now documented rather than silently resolved.

**Confirmed sound, so no task needs to re-derive them.** `resize-window` really does flip `window-size` to `manual` — Task 5's premise, and its test genuinely fails today. `show-hooks -w -t <window>` works on 3.7b, so Task 4's read-back is valid. `windowsIn`, `windowSize`, `sessionExists` and `waitFor` all already exist in `manager.test.ts`; `adapter.test.ts` has `afterEach(killServer)`, so Task 1's two same-named sessions cannot collide. `TmuxNotInstalledError` does throw on a bad `bin`, with a precedent already in `adapter.test.ts`. Task 8's premise holds: `register.ts:376` calls the singular method and no `register.test.ts` exists.
