# M2c Plan 2b — Splits You Can See and Use

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a split reachable. Plan 2a shipped the whole model headless — a split tab survives a relaunch with its axis, ratios and selected pane — and there is no way to create one from the UI. At the end of this plan there is: ⌘D / ⇧⌘D to split, ⌘W to close a pane, ⌘⌥arrows to move between them, a tab dot that tells the truth about the panes inside it, and a dead pane you can read before you dismiss it.

**Architecture:** Flat panes plus a parallel tab index, end to end. Config v5, the IPC payload and renderer state all carry `panes[]` and `tabs[]` with layout. Main's payload is authoritative; the renderer never invents tab membership.

**Tech Stack:** TypeScript, Electron main process, React renderer, node-pty, real tmux 3.7b via `TmuxAdapter`, Vitest (`npm test`), Playwright (`npm run e2e`).

**Scope:** IPC, wire, renderer pane tree, focus, per-pane death, worst-state aggregation. **Not** drag-resize, the `⊞n` badge, or E2E — those are plan 2c.

**Spec:** `docs/superpowers/specs/2026-07-31-prcli-m2c-splits-design.md` — §Plan 2b rulings and §Config v5.
**Parent design:** `docs/superpowers/specs/2026-07-30-prcli-design.md` §Layout fixes the interaction: Split Right ⌘D, Split Down ⇧⌘D, ⌘W kill pane, context menu on tab or pane.
**Reviews this plan inherits from:** `docs/superpowers/reviews/2026-08-01-prcli-m2c-plan2a-branch-review.md` (I4, I5) and `…-rereview.md`.

## Global Constraints

- Tests use `-L prcli-test` only, via `new TmuxAdapter({ socket: 'prcli-test' })`. **Never the default socket.** `tmux -L prcli-test kill-server` is the established teardown; a bare `kill-server` is forbidden.
- Tests never touch the real `~/.prcli` (`PRCLI_CONFIG_DIR`), `~/Code` (`PRCLI_PROJECTS_ROOT`) or `~/.claude/settings.json` (`PRCLI_CLAUDE_SETTINGS`) — the last is read by roughly twelve live Claude sessions.
- **Never run `npm install` / `npm ci`.** It breaks node-pty's spawn-helper permissions and fails every integration test with `posix_spawnp failed`.
- **Never weaken, delete or loosen a test assertion, timeout or poll interval to make something pass.** If an assertion contradicts the code, stop and report.
- **Never assert over a collection without first asserting it is non-empty.** `[].every(...)` is `true`.
- **`expect.poll` cannot assert the absence of a change.** It returns on its first match, so it reads the value before an unwanted write lands. Poll for a transition; settle then assert plainly for a non-change. This produced a test that passed against the very defect it named, on the last plan.
- **Assert on state read back from tmux, never on an exit code.** Every defect in plan 1 was a command that exited 0 and did nothing.
- A group name's slug is frozen at creation and must **never** be read; only its 16-hex id, via `tabIdFromGroupName`.
- `register.ts`'s `serialise` queue has **no reentrancy protection**. Nothing running inside it may call it again.
- Comments explain *why*, citing what was measured. **A comment asserting a mechanism that is not true is a defect here** — four were found in plan 1, one in plan 2a, and four more in plan 2a's own fix wave.
- A/B every load-bearing assertion by breaking the production code it guards. **Before committing, `git diff` on production files must be empty of the mutation.** Twelve tests that could not fail have been found on this project; a green suite caught none of them.
- `App.tsx` keeps every terminal mounted and toggles `visibility`, not `display`. A hidden pane must stay laid out so it can measure itself — one that measures 0×0 resizes its real tmux session to nothing. **Both properties must survive this plan.**

---

### Task 1: The wire carries tabs, and calls a pane a pane

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/ipc/restore.ts`, `src/main/ipc/register.ts`, `src/preload/index.ts`, `src/renderer/workspace.ts`, `src/renderer/App.tsx`
- Test: `tests/integration/restore.test.ts`, `tests/unit/workspace.test.ts`

`RestoreResult.tabs` is `TabDescriptor[]` and holds **panes**. Restore has built correct `TabRow[]` since plan 2a and then dropped them on the floor — review finding I5. Nothing downstream can lay out a split because nothing downstream is told one exists.

- [ ] **Step 1: Write the failing tests**

`restoreWorkspace`'s result carries `panes: TabDescriptor[]` **and** `tabs: TabRow[]`, and the tab rows match what it wrote to disk — same ids, same `kids`, same `dir`, ratios summing to 1. Assert the tab count before iterating, and assert the ratio sum rather than only its length.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

Rename `RestoreResult.tabs` → `panes`, add `tabs: TabRow[]`. `restoreWorkspace` already computes both; return them. Thread the rename through `register.ts`'s restore handler, the preload bridge and the renderer.

`TabRow` is declared in `src/main/state/store.ts` and the renderer cannot import from main. Move it to `src/shared/ipc.ts` alongside `TabDescriptor` and re-export from `store.ts`, the same way `PaneRecord`/`NotificationConfig` already work — one declaration, no drift.

- [ ] **Step 4: Run** — the changed files, then full `npm test` and `npm run typecheck`.

- [ ] **Step 5: A/B** — return `tabs: []` from restore and confirm a test fails. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Tell the renderer which panes share a tab"`

---

### Task 2: `restartTab` rejoins its group

**Files:**
- Modify: `src/main/ipc/register.ts` (the `restartTab` handler), possibly `src/main/sessions/manager.ts`
- Test: `tests/integration/persistence.test.ts`

Carried finding **I4**, inert until now and live the moment Task 4 offers restart on a pane. `restartTab` recreates a pane with a bare `new-session -A` and no `-t <group>`, so restarting a pane inside a split resurrects it **outside** its tab's group — silently un-splitting the tab, with the restarted pane becoming its own one-pane tab on the next restore.

- [ ] **Step 1: Write the failing test**

Split a tab, kill one pane's process, restart that pane, and assert it is **still a member of the same group** — read `#{session_group}` back from tmux for both panes and assert they match and are non-empty. Assert the pane list is non-empty first.

- [ ] **Step 2: Run to verify it fails** — expected: the restarted pane's `session_group` is empty, or differs.

- [ ] **Step 3: Implement**

A pane whose tab has other live members must rejoin rather than be created fresh: the group, a new window in it, a member session bound to that window — the sequence `splitTab` already performs. Prefer reusing `splitTab`'s path over a second copy of it; if the shapes genuinely differ, say why in your report rather than duplicating silently.

A pane that is its tab's **only** member has no group to rejoin and `new-session -A` is right for it. Keep that path working and say in the comment which case is which.

- [ ] **Step 4: Run** — the file, then full `npm test`.

- [ ] **Step 5: A/B** — restore the bare `new-session -A` for the grouped case; confirm the test fails with the pane outside its group. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Restart a pane back into its tab, not beside it"`

---

### Task 3: Split and close-pane IPC

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/ipc/register.ts`, `src/preload/index.ts`
- Test: `tests/integration/persistence.test.ts`

**Interfaces:**
- Produces: `CHANNELS.splitPane`, `CHANNELS.closePane`.
  - `splitPane(paneId: string, dir: 'row' | 'col'): Promise<{ panes: TabDescriptor[]; tabs: TabRow[] }>`
  - `closePane(paneId: string): Promise<{ panes: TabDescriptor[]; tabs: TabRow[] }>`

Both return the tab's whole shape rather than the one pane that changed: the caller needs the new `kids` order and ratios anyway, and a renderer that patches its own arrays from a partial reply is a second place for membership to drift.

- [ ] **Step 1: Write the failing tests**

Drive both handlers through the mocked `ipcMain` the persistence tests already use.

For `splitPane`: two panes, one group, both `session_group`s equal and non-empty, each pane's own `PRCLI_TAB_ID` reaching its own process; **config holds a pane row for each and one tab row whose `kids` are both ids with ratios summing to 1**; and `dir` is what was asked for.

For `closePane`: closing one pane of two leaves the sibling running with its own window, removes the closed pane's row, and leaves a tab row whose remaining ratio sums to 1. Closing the **last** pane closes the tab — no pane row, no tab row, no session.

Assert counts before iterating.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`splitPane` calls `manager.splitTab({ paneId, cols, rows })` and then, inside the same `serialise` pass: `rememberTab` the new pane and write the tab row itself — its `kids` with the new pane inserted **after** its sibling, `dir` as asked, ratios even across the kids. Nothing writes a multi-pane tab row today; this is the code path plan 2a's test seeded by hand.

`closePane` calls `manager.kill(paneId)` — which since plan 2a reaps the pane's window too — then `forgetTab`s the pane row and rewrites the tab row without that kid, redistributing its ratio. A tab left with no kids loses its row.

`splitTab` takes `cols`/`rows`; pass the renderer's measured size for the new pane. **Do not pass a default** — plan 2a's I1 was a default-sized attach driving a window to 80×24, and `open()` now deliberately treats "no size given" as "do not size the window".

- [ ] **Step 4: Run** — the file, then full `npm test`, `npm run typecheck`, `npm run check-deps`.

- [ ] **Step 5: A/B** — twice. Make `splitPane` skip writing the tab row and confirm a test catches the missing layout; make `closePane` skip the ratio redistribution and confirm a test catches ratios not summing to 1. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Give the UI a way to make and unmake a pane"`

---

### Task 4: The renderer holds panes and tabs

**Files:**
- Modify: `src/renderer/workspace.ts`
- Test: `tests/unit/workspace.test.ts`

**Interfaces:**
- Produces: `WorkspaceState` gains `panes: TabDescriptor[]` (renamed from `tabs`) and `tabs: TabRow[]`.

- [ ] **Step 1: Write the failing tests**

Every existing action still resolves a pane by id after the rename. New: a `split` action inserts the pane and replaces the tab row; a `closedPane` action removes both; `activatedPane` sets the tab's `activePaneId`; and a payload naming a pane in no tab's `kids` is **not** invented into one — the renderer trusts main.

Cover the reducer's existing 46 tests continuing to pass; a rename that quietly drops one is the failure mode here.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

Rename `state.tabs` → `state.panes` throughout, add `state.tabs: TabRow[]`. Add the three actions. Keep pane lookups flat.

Helper functions the rest of the plan needs, here rather than scattered: `panesOfTab(state, tabId)` in `kids` order, and `tabOfPane(state, paneId)`.

- [ ] **Step 4: Run** — the file, then full `npm test`.

- [ ] **Step 5: A/B** — make `closedPane` drop the pane but leave its `kids` entry; confirm a test fails. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Hold panes and tabs the way config does"`

---

### Task 5: The pane tree renders

**Files:**
- Modify: `src/renderer/App.tsx`, `src/renderer/Terminal.tsx` (if it needs a size hint)
- Test: `tests/unit/workspace.test.ts` or a new renderer test if one fits the layout

**This is the task most likely to reintroduce a geometry defect.** Read the constraint at the top of this plan before starting.

- [ ] **Step 1: Write the failing test**

The current tab's panes render along `layout.dir`, in `kids` order, sized by `ratio`. Every pane of every tab stays **mounted**; only the current tab's are visible. A hidden pane still has a non-zero measured box.

If a DOM-level assertion on flex sizing is not practical in this suite, say so and assert the layout function's output — the per-pane style objects — instead, and say in your report which you did and why.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

Replace `state.tabs.map(...)`'s flat absolute positioning with: one absolutely-positioned container per **tab** (visibility-toggled exactly as tabs are today), and inside it a flex row or column of that tab's panes with `flex-basis` from `ratio`.

**Do not unmount a hidden tab's panes and do not switch to `display: none`.** Unmounting disposes the xterm and loses scrollback; `display: none` makes the container measure 0×0, and `Terminal.tsx`'s `fitToContainer` would then resize the real tmux session to nothing. The existing guard — `if (container.offsetParent === null) return` — protects against the second, so verify it still fires for a hidden *pane* and not only a hidden tab.

- [ ] **Step 4: Run** — the file, then full `npm test`. Then **launch the app** (`npm start`) and confirm a split renders two panes side by side at sensible sizes. Report what you saw; this is the first time splits are visible.

- [ ] **Step 5: A/B** — swap `flex-basis` for a fixed even split and confirm a test catches ratios being ignored. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Lay a tab's panes out along its axis"`

---

### Task 6: Focus, and the keys that drive it

**Files:**
- Modify: `src/renderer/App.tsx`, `src/main/index.ts` (menu accelerators), `src/renderer/Terminal.tsx`
- Test: `tests/unit/workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

⌘D and ⇧⌘D split the **active pane** of the current tab along `row` and `col` respectively. ⌘W closes the active pane; on a one-pane tab it closes the tab. ⌘⌥←/→ move the active pane one step along a `row` axis and ⌘⌥↑/↓ along a `col` axis; at either end the active pane does not change. Clicking a pane makes it active.

Assert the pane list is non-empty before indexing into it.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

Accelerators go through the existing `CHANNELS.menuCommand` path rather than a renderer key handler: an xterm with focus consumes most keystrokes, and the app menu is what already owns ⌘-chords here. Follow how ⌥⌘1 and ⇧⌘\ are wired.

A movement that would fall off either end is a no-op, not a wrap — wrapping puts focus at the far side of the screen from where the key pointed.

Focus follows `activePaneId`: when it changes, that pane's xterm takes DOM focus, or typing goes to whichever terminal happened to hold it.

- [ ] **Step 4: Run** — the file, then full `npm test`. Then **launch the app** and confirm every binding by hand, including that ⌘D on a Claude pane does not steal a keystroke Claude needed. Report what you saw.

- [ ] **Step 5: A/B** — make ⌘⌥ movement wrap at the ends; confirm a test fails. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Say which pane is listening, and let the keyboard move it"`

---

### Task 7: A dead pane you can still read

**Files:**
- Modify: `src/renderer/App.tsx`, `src/renderer/StatusDot.tsx` or the pane chrome
- Test: `tests/unit/workspace.test.ts`

- [ ] **Step 1: Write the failing test**

A pane whose session died keeps its place and its ratio, shows a red dot, and offers restart and dismiss. Its siblings do **not** resize. Restart puts a live pane back in the same slot — and, per Task 2, back in the same group. Dismiss removes it and redistributes its ratio.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

Reuse M3's per-tab restart/dismiss affordances at pane level rather than inventing a second idiom. The ruling and its reason are in the spec: the scrollback is what you need when something dies, so a dead pane does not collapse.

Say in the comment why this differs from restore, which *does* prune a dead pane — a pane dead in this session still has a window, a preserved dead pane and scrollback; a pane missing at restore has nothing to show.

- [ ] **Step 4: Run** — the file, then full `npm test`.

- [ ] **Step 5: A/B** — collapse the dead pane instead; confirm a test catches the siblings resizing. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Leave a dead pane where you can read it"`

---

### Task 8: A dot that tells the truth

**Files:**
- Modify: `src/renderer/TabBar.tsx`, `src/renderer/Sidebar.tsx`, `src/renderer/workspace.ts`
- Test: `tests/unit/workspace.test.ts`, `tests/unit/status.test.ts`

A split tab's tab-bar dot currently shows one pane's state. A crashed second pane leaves the tab looking green — the failure this task exists to prevent, on a tool whose job is triage.

- [ ] **Step 1: Write the failing tests**

A tab's dot is the worst state among its panes, and a project row's is the worst among its tabs, using the order already exported as `SEVERITY` in `src/shared/status.ts`. Cover every pair that could invert — `crashed` beside `idle`, `waiting` beside `running` — and assert the pane list is non-empty first. A tab whose panes are all `unknown` is `unknown`, not absent.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

One fold, used by both the tab bar and the sidebar. **Import `SEVERITY`; do not re-declare the order** — `status.ts`'s own comment says a second copy of it is the thing to avoid.

- [ ] **Step 4: Run** — the files, then full `npm test`, `npm run typecheck`, `npm run check-deps`.

- [ ] **Step 5: A/B** — reverse the fold so it takes the *best* state; confirm the `crashed`-beside-`idle` test fails. Restore; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Make a tab's dot the worst of what is inside it"`

---

## Deliberately not in this plan

- **Drag-resize.** Plan 2c. The ruling stands: a drag writes config once, on mouse-up, with ratios in renderer state during the gesture and `resize-window` firing live.
- **The `⊞n` badge.** Plan 2c. Cosmetic, and it needs the tab bar's split-tab layout settled first.
- **E2E.** Plan 2c. The suite is already flaky under load and splits add surface to it; the idle-machine experiment is worth running before adding more.
- **Arbitrary pane nesting.** Still deferred. The tmux model has no opinion about arrangement, so it stays a config-and-renderer change whenever it is wanted.
- **Detach-a-pane-to-its-own-tab, and dragging a pane between tabs.** Out of scope for M2c per the spec.

## Self-review

**Spec coverage.** §Plan 2b rulings: scope → the whole plan; focus → Task 6; dead pane stays → Task 7; renderer state shape → Task 4; aggregation moved into 2b → Task 8. §Config v5 → Tasks 1, 3. Parent design §Layout: ⌘D/⇧⌘D/⌘W → Task 6; per-pane dots → Tasks 7, 8. Review carry-ins: I4 → Task 2; I5 → Task 1; `rememberTab`-per-pane → Task 3.

**Ordering.** Task 1 first because nothing downstream can lay out a split until the wire carries tab rows. Task 2 before Task 7 because Task 7 offers the restart that makes I4 live. Task 3 before Task 4 because the renderer's actions mirror the IPC payloads. Task 5 before Task 6 because focus needs something laid out to move around. Task 8 last because it reads state every earlier task settles.

**Known soft spots, stated rather than hidden.**
- Task 5's assertion may not be practical at DOM level in this suite; the task says to assert the layout function's output instead and to report which route was taken.
- Tasks 5 and 6 both ask for a manual launch. That is deliberate: splits have never been on screen, and every geometry finding in this milestone came from tests rather than eyes.
- Task 3 must choose the new pane's size from the renderer. Passing a default would walk straight back into plan 2a's I1, which is why `open()` now treats "no size given" as "do not size the window".
