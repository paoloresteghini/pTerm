# PRCLI E2E Revival — the suite is alive; make it trustworthy, then make it see a drag

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Playwright suite from a thing nobody runs into the one mechanism in this repo that can watch a human use the app — and then point it at the M2c surface no test anywhere can currently see: splits, tombstones, and the drag gesture.

**Base:** `master` at `5ba3abf`. (Was `m2c-plan2c-drag-resize` at `bf65c26` when this was drafted; the tombstone-membership work landed on top of it, and several of this plan's premises moved with it — see *What changed under this plan*, below.)

---

## BLOCKING PRECONDITION: this plan cannot be executed until the machine is rebooted

Measured 2026-08-02, on this machine, before any of the revisions below were written:

```
$ python3 -c "import pty; pty.openpty()"
OSError: out of pty devices
```

643 pty file descriptors are open across 179 processes. **429 of them are held by `zsh`** — Paolo's own concurrent sessions, not leakage from any test suite. Of the twenty socket files in `/private/tmp/tmux-501/`, exactly one (`default`) has a live server behind it: 2 sessions, 4 panes, the real work. The other nineteen are dead socket files left by past runs and hold nothing.

**There is nothing safe to reclaim.** The dead sockets are already free; killing the `default` server would destroy the user's real sessions, which the Global Constraints below forbid outright.

Every task in this plan needs at least one tmux session. Tasks 6, 7 and 8 need **two apiece** — a split is a second session, not a second window. So:

- **Do not start this plan on a machine that cannot open a pty.** `python3 -c "import pty; pty.openpty()"` succeeding is the pre-flight check; run it first, every time.
- A failure mode to recognise rather than debug: a starved pty surfaces as `posix_spawnp failed`, `fork failed: Device not configured`, or an assertion reading `expected '' to be …`. **Count those before believing any task here found a defect.** The self-review's last bullet says the same thing and is the reason it is repeated up here.
- The fix is a reboot, not a cleanup.

Everything below is written to be executable the day that check passes. Nothing below has been run.

---

## What changed under this plan between `bf65c26` and `5ba3abf`

This plan was drafted against `bf65c26` and reviewed against `5ba3abf`. Four of its premises moved in between, and the revisions are recorded here rather than folded in silently, because each one changes what a task is *for*:

1. **Task 2's Step 1 shipped.** All four E2E specs now set `PRCLI_CLAUDE_SETTINGS` (`b12416b`, merged at `626df41`), and `tests/unit/e2eSafety.test.ts` enumerates `tests/e2e/*.spec.ts` and fails if any spec omits any of the four vars. Task 2 keeps **only** its Step 2 and that step's two A/Bs, for a reason given there: the shipped guard is a source-text token check, so a var pointing at the *wrong path* still satisfies it.
2. **`CHANNELS.setLayout` changed shape, and its length guard is gone.** It is now `(tabId, shares: Record<paneId, number>)` — `register.ts:742` — and membership is routed by name through `layoutWrite`/`routeShares` rather than matched by position. The guard this plan was built around no longer exists. Five places in this document asserted otherwise; each has been rewritten or cut, and each cut says so where it was.
3. **`dividers.test.ts`'s header is not the header this plan quotes.** Three of the six items in the list that formed this plan's central argument have since been covered by `workspace.test.ts`'s `grabFor` describe. The argument still holds — it is just smaller than it was, and it is restated below at its real size rather than at its 2026-08-01 size.
4. **The dead-assertion count is twenty, not fifteen.** `00c7133` repaired five more, two days after this plan wrote "fifteen".

Ten further defects were found in the plan's own snippets. They are corrected at their tasks and indexed as **D1–D10** in the Self-review, below.

## Flagged for Paolo — decided by nobody but him

Five things in this revision would have changed what the plan is *for*, so they are marked and left open rather than resolved. Each is argued in full where it lives; this is only the index.

1. **The conservation assertion — add a three-pane drag, or drop the recommendation.** Controller review item 2. As written it asserts nothing on a two-pane row and only bites at three or more panes, which this plan declines. Both options are laid out with their costs; neither is chosen. → *Controller review, item 2.*
2. **How to shrink the window for the ⌘D-refusal test.** A main-process `setSize` reach-in through `app.evaluate`, or a `launchApp` option that touches the harness Task 3 just froze. Pick one. → *Task 6, Step 3.*
3. **Two panes or three for the tombstone drag**, and whether a two-pane row with one tombstone presents a grabbable divider at all — untraced. → *Task 8, Step 3.*
4. **Whether `claudeSettingsPath()` should refuse its `homedir()` fallback under a test env.** The stronger fix, and a **product change** this plan is otherwise scoped not to make. → *Controller review, item 3.*
5. **Whether M2c 2c's CT-2 is still a live defect.** CT-1 is fixed. CT-2 I did not confirm either way, and the closing paragraph of the controller review turned on both. → *end of Controller review.*

Also unruled, and carried over unchanged from the draft: **Open Questions 1, 3, 4, 5 and 6.** Open Question 2 has been answered by events and is struck through with its reasoning preserved.

---

## The finding that reshapes this plan: the suite is not broken

It was believed broken. It is not. Measured on 2026-08-01 at 23:52, on this branch, at `bf65c26`:

```
npm run e2e -- --reporter=list
Running 34 tests using 1 worker
  ... 34 ✓ ...
  34 passed (47.6s)
```

**34 of 34 green, in 47.6 seconds, with zero resource errors** — no `posix_spawnp failed`, no `fork failed: Device not configured`, no `expected '' to be …`, in error text or inside assertion text. Nothing was starved. `/dev/ttys*` was 422 before the run and 422 after: **an entire E2E run allocates no net ptys**, because the app opens one tmux session per test and `afterEach` kills the per-file server before the next test starts. That number is the opposite of the integration suite's, and it is the single most useful operational fact in this document.

`test-results/.last-run.json` reads `{"status":"passed","failedTests":[]}`, and its mtime is **Jul 31 11:07** — which is also the mtime of the four stale sockets in `/private/tmp/tmux-501/`. So the suite was last run at 11:07 on Jul 31, went green, and has not been run since. Everything from `2e9500a` (splits core) through `bf65c26` (drag-resize) landed after it. **The belief that it was broken was a belief about a suite nobody had run for a day and a half, not an observation.**

Two secondary facts, both measured, both load-bearing below:

- `.vite/build/main.js` on disk before the run was a **dev** build with `http://localhost:5174` baked into it, and `.vite/renderer/` did not exist. Every spec's `beforeAll` runs `npm run package`, which replaced it with a production build and created `.vite/renderer/main_window`. So E2E **overwrites the running dev build's artifact**, four times per run, once per spec file. It was restored by snapshot copy after this investigation; `git status` is clean and `.vite/`, `out/` and `test-results/` are all gitignored.
- `~/.prcli/config.json` (mtime Aug 1 23:37) and `~/.claude/settings.json` (mtime Jul 28) were **both untouched** by the run. That is luck in one case, not design — see Task 2.

So this is not a repair plan. It is an audit-and-extend plan, and the tasks are ordered accordingly: prove the green means something (1), close the safety hole (2), make the harness honest and a failure legible (3–4), then buy the coverage that motivated the whole thing (5–8).

## Why this is worth a plan at all: nothing in this repo can see a drag

`tests/unit/dividers.test.ts` covers the drag gesture by reading `App.tsx` and `PaneDivider.tsx` as *text*, because `vitest.config.mts` runs `environment: 'node'` — there is no DOM, and its own header explains that a DOM would not be enough either, since jsdom performs no layout and `offsetWidth` and a percentage `left` would both report nothing about the thing at stake. That header then lists, in the author's own words, what it cannot see.

**This list is shorter than it was when this plan was drafted, and the plan is corrected rather than left standing on the old one.** At `bf65c26` it ran to six items. Three of those have since been covered by other tests, and the current header (`tests/unit/dividers.test.ts:39-57`) says so in as many words: `grabPane`'s three refusal guards and the floor derivation both moved into `grabFor` in `workspace.ts` and are now pinned as *arithmetic* by `workspace.test.ts`'s `grabFor` describe, and what main persists is pinned by `shares.test.ts` and `persistence.test.ts`. Quoting what is actually left, rather than what was left in August's first draft:

- *"that a pointerdown starts a drag at all, or that a pointerup ends one"*
- *"where the divider lands"* — `offset` is a cumulative sum computed in `App.tsx` and turned into a percentage at runtime, and, measured: replacing `slice(0, index)` with `slice(0, index - 1)` draws every divider one seam early, the first flush against the tab's leading edge, and **eleven of eleven assertions still pass**. So does replacing `${offset * 100}%` with a constant `0%`, which stacks every divider in the app at that edge. The header adds the trap: changing the render gate from `index > 0` to `index >= 0` *is* caught, but only because `>=` is different **text** from `>`. "Do not read that failure as coverage of placement."
- *"that a pane follows the cursor 1:1 over a long drag, that it stops at the floor, or that the tmux session reflows behind it"*

Two further items on that list are also uncovered — *"that the cursor changes, or that a 7px strip is comfortable to hit"* and *"that React actually calls the effect's cleanup"* — and this plan covers neither of them either. They are named here so the list is not read as exhaustive of what E2E buys.

The header closes: *"A human with the app open is the only thing that sees any of those."* That is still true of the three items above, and it does not have to stay true. A working E2E suite is the only mechanism in this repo that could ever cover a single one of them. It exists, it is green, and it costs 47 seconds and no ptys.

**Is three items still worth Task 8?** Yes, and the reason is the second bullet rather than the count. Divider *placement* — where the seam is drawn, whether the pane follows the cursor, whether it stops — is the part of this gesture that no test can be written for without a real layout engine, and it is the part where two measured mutations pass a green suite while visibly breaking the app. The other three items were covered by moving arithmetic somewhere it could be tested; placement cannot be moved anywhere, because it *is* the rendering. That is the whole argument, at its real size.

## Architecture

Four spec files, one Electron app per test, `workers: 1`, `fullyParallel: false`. Each file owns a **different tmux socket** — confirmed from the `const SOCKET` at the top of each file, not from the socket names on disk:

| File | `SOCKET` | Tests |
|---|---|---|
| `tests/e2e/launch.spec.ts` | `prcli-e2e` | 3 |
| `tests/e2e/projects.spec.ts` | `prcli-e2e-projects` | 10 |
| `tests/e2e/status.spec.ts` | `prcli-e2e-status` | 10 |
| `tests/e2e/tabs.spec.ts` | `prcli-e2e-tabs` | 11 |

Every one of the 14 `kill-server` invocations under `tests/` is `-L`-scoped; there is no bare `kill-server` anywhere in the repo. The four stale sockets dated Jul 31 are exactly these four, left by the last run.

Each file duplicates `launch()`, `killServer()`, `sessionNames()` and a `beforeAll` that shells out to `npm run package`. That duplication is where Task 2's safety hole came from — four copies of the `env` block, three of which had drifted — and Task 3 removes it. The hole itself is closed (`b12416b`); the duplication that produced it is not.

**Selector coupling is healthier than expected.** Every `getByTestId` the specs use resolves against current `src/renderer/`: `new-tab`, `terminal`, `terminal-active`, `tab-*`, `close-*`, `dot-*`, `sidebar`, `rightpanel`, `empty-state`, `add-project`, `candidate-*`, `project-*`, `pmenu-*`, `prename-*`, `premove-*`, `pdot-*`, `rename-input-*`, `smove-*`, `preset-*`, `needs-*`, `needs-you-count`, `restart-*`, `settings-open`, `hooks-status`, `hooks-install`, `hooks-uninstall`. Two that look like rot are not: `preset-marker` is `` `preset-${preset.label}` `` for a preset the spec itself declares, and `project-unsorted` is `` `project-${project.id}` `` for the synthetic Unsorted row. **No selector has rotted.** What has happened instead is that a large new selector surface — `pane-*`, `dividers-*`, `pane-divider`, `dead-*`, `pane-restart-*`, `pane-dismiss-*` — appeared in M2c and **no spec mentions any of it**.

## Global Constraints

- **E2E uses its own sockets only** (`prcli-e2e*`), the integration suite uses `-L prcli-test`, and **a bare `tmux kill-server` is forbidden anywhere** — it would destroy the user's real sessions.
- Tests never touch the real `~/.prcli` (`PRCLI_CONFIG_DIR`), `~/Code` (`PRCLI_PROJECTS_ROOT`), or `~/.claude/settings.json` (`PRCLI_CLAUDE_SETTINGS`). **All four overrides, in every launch, in every file.** All four specs now set all four, and `tests/unit/e2eSafety.test.ts` fails if a spec omits one — see Task 2 for what that guard still does not catch, and Task 3 for the one way this plan can break it.
- **Never run `npm install` / `npm ci`.** It breaks node-pty's spawn-helper permissions and fails every integration test with `posix_spawnp failed`. Note that `npm run package` *does* run `@electron/rebuild` against `node_modules/node-pty` (the `build/Release/` tree dated Jul 31 07:47 is its output) and has not broken anything so far — but if the integration suite ever fails with `posix_spawnp failed` right after an E2E run, `node scripts/fix-node-pty-perms.js` is the first thing to try, not a reinstall.
- **Never weaken, delete or loosen a test assertion, timeout or poll interval to make something pass.** If an assertion contradicts the code, stop and report.
- **Never assert over a collection without first asserting it is non-empty.** `[].every(...)` is `true`.
- **`expect.poll` cannot assert the absence of a change.** It returns on its first match. Poll for a transition; settle then assert plainly for a non-change.
- **Every task ends with an A/B step:** break the production code the new assertion guards and confirm the test fails. This project has found **twenty tests that could not fail** — fifteen when this plan was drafted, plus the five `00c7133` repaired two days later — and a green suite caught every one of them. An E2E suite is unusually prone to this — a spec that waits for a selector which always exists asserts nothing.
- **Restore an A/B by snapshot copy** (`cp file file.bak` … `cp file.bak file`), **never `git checkout -- <file>`** — that restores to HEAD and once wiped an entire uncommitted fix. Before committing, `git diff` on production files must be empty of the mutation.
- **A comment asserting a mechanism that is not true is a defect here.**
- **What is not covered must be declared, not implied.**
- Run E2E **only when no `npm start` dev build is running**, or accept that `.vite/build/main.js` is replaced under it (Task 3 makes this a documented precondition rather than a surprise). A packaged `/Applications/PRCLI.app` running alongside is harmless — it loads from its own path.
- E2E allocates **no net ptys**. Do not budget for it as if it were the integration suite. Do budget ~50s of wall clock.

## File Structure

- `tests/e2e/harness.ts` — **new.** The one `launchApp`, the one `killServer`, the one `sessionNames`, the one place the four env overrides are named.
- `tests/e2e/global-setup.ts` — **new.** `npm run package`, once per run instead of four times.
- `playwright.config.ts` — gains `globalSetup`, `reporter`, `use.trace`, and a comment saying what `workers: 1` is actually protecting.
- `tests/e2e/launch.spec.ts`, `projects.spec.ts`, `status.spec.ts`, `tabs.spec.ts` — lose their duplicated harness, gain a declared-non-coverage header.
- `tests/e2e/splits.spec.ts` — **new.** Tasks 6–8. Socket `prcli-e2e-splits`.

---

### Task 1: Prove the green means something

The suite passes. Nothing has established that it *can fail*. Twenty tests in this repo could not, and every one of them was green. Before a single new assertion is written, the existing 34 have to be shown to be load-bearing.

**Files:**
- Modify (temporarily, then restore by `cp`): `src/renderer/App.tsx`, `src/renderer/TabBar.tsx`, `src/main/ipc/register.ts`, `src/main/sessions/manager.ts`
- Modify (permanently): the four spec files' top-of-file comments

**Interfaces:** none — this task produces a measurement and four header comments.

- [ ] **Step 1: Snapshot every file you are about to mutate**

```
cp src/renderer/App.tsx /tmp/ab-App.tsx
cp src/renderer/TabBar.tsx /tmp/ab-TabBar.tsx
cp src/main/ipc/register.ts /tmp/ab-register.ts
cp src/main/sessions/manager.ts /tmp/ab-manager.ts
```

`cp`, not `git stash`, not `git checkout --`. Restore from these after every mutation below.

- [ ] **Step 2: Four mutations, one per spec file, each aimed at that file's stated subject**

Run one mutation at a time, run **only the file it targets** (`npx playwright test tests/e2e/<file>` — ~5–8s each), record which tests fail, restore by `cp`, and confirm `git diff` on that production file is empty before the next.

| Target file | Mutation | Expect |
|---|---|---|
| `launch.spec.ts` | In `Terminal.tsx`, change `data-testid="terminal"` to `data-testid="terminal-box"` | all 3 fail |
| `tabs.spec.ts` | In `App.tsx`'s `onKeyDown`, change `event.code === 'KeyW'` to `event.code === 'KeyQ'` | `the keyboard opens, switches and closes tabs` fails; the other 10 pass |
| `projects.spec.ts` | In `App.tsx`, delete the `if (event.altKey)` branch inside the `Digit` handler so ⌥⌘1 falls through to project switching | `⌘1 and ⌘2 switch project; ⌥⌘1 and ⌥⌘2 switch tab` fails |
| `status.spec.ts` | In `register.ts`, make `CHANNELS.installHooks` resolve without writing | `install and uninstall leave an unrelated hook untouched` fails |

The `tabs.spec.ts` row is the interesting one: it is chosen so that **exactly one** test fails. A mutation that fails everything proves only that the app still starts.

**"Exactly one" is a claim about `tabs.spec.ts`, not about the suite.** Verified at `5ba3abf`: `projects.spec.ts:307` also presses `Meta+w`, inside `⌘W closes a tab even with the terminal focused`, so the `KeyW`→`KeyQ` mutation breaks that test too. That is not a reason to change the mutation — the point of the row is a mutation whose blast radius inside its own file is one test, and it is. **Run it file-scoped** (`npx playwright test tests/e2e/tabs.spec.ts`), record it as file-scoped, and do not write "exactly one test in the suite" into the header the way this table's first draft implied. If you run the whole suite for this row, expect **two** failures and treat the second as confirmation rather than a finding.

- [ ] **Step 3: Any test that survived a mutation aimed squarely at it is a finding**

Write it down with the mutation that failed to move it. Do not fix it in this task and do not delete it — Task 5 decides what to do with it, and the Open Questions below reserve the delete/keep call for the author.

- [ ] **Step 4: Give each spec a declared-non-coverage header**

Follow `tests/unit/dividers.test.ts`'s house style: what the file covers, then a **What this file does NOT see** list, then measured edits that pass anyway. Use the Step 2 and Step 3 results — this header must be measurement, not guesswork. At minimum, each header states that the file drives a **one-pane tab only**, so nothing in it exercises `paneGroups`' multi-box branch, `boxesOfRow`, the dividers overlay, or `DeadPane`.

- [ ] **Step 5: A/B this task's own deliverable**

The header is prose and cannot fail. The deliverable that *can* is the mutation table: re-run one row (the `tabs.spec.ts` one) and confirm the recorded pass/fail split reproduces exactly. If it does not, the table is wrong and the header built on it is a comment asserting a mechanism that is not true.

---

### Task 2: the four overrides, asserted at runtime rather than counted in source

**Most of this task shipped while the plan sat.** What it found — that `status.spec.ts` set `PRCLI_CLAUDE_SETTINGS` and the other three specs did not, so one added click on `hooks-install` in any of them would have rewritten the developer's real `~/.claude/settings.json` — was fixed at `b12416b`, merged at `626df41`. All four specs now set all four vars, verified at `5ba3abf`. **This task's original Step 1 is cut for that reason and only that reason;** the finding was correct and the fix is in.

`tests/unit/e2eSafety.test.ts` landed with it: it enumerates `tests/e2e/*.spec.ts` — enumerates, not names, so a fifth spec is covered the day it lands — strips comments, and fails if any spec is missing any of the four `VAR:` tokens.

**What survives, and why this task is not deleted outright.** That guard is a **source-text token check**. It asks whether the characters `PRCLI_CLAUDE_SETTINGS:` appear in the file. A spec that sets

```ts
PRCLI_CLAUDE_SETTINGS: join(homedir(), '.claude', 'settings.json'),
```

satisfies it completely. So does one that sets it to a path it never creates, or to another spec's temp dir, or to a stale variable that is `undefined` at launch. The guard closes "a spec author forgot the line"; it cannot close "the line points somewhere dangerous", and that second failure has exactly the same blast radius as the first. **Only a runtime assertion inside the launched app closes it**, and that is Step 2 below, unchanged from the draft. Its A/B (b) is the whole point of keeping it.

**Files:**
- Modify: `tests/e2e/launch.spec.ts`

**Interfaces:** none — one new test in an existing file.

- [ ] **Step 1: Add the runtime guard**

One test, in `launch.spec.ts`, that asserts the app is running against overridden paths rather than trusting the spec author to have set them:

```ts
test('runs against overridden paths, never the developer’s own', async () => {
  const app = await launch()
  const seen = await app.evaluate(() => ({
    config: process.env.PRCLI_CONFIG_DIR,
    projects: process.env.PRCLI_PROJECTS_ROOT,
    settings: process.env.PRCLI_CLAUDE_SETTINGS,
    socket: process.env.PRCLI_TMUX_SOCKET,
  }))
  // Asserted as "is the temp path we made", not as "is set": an override
  // pointing at the wrong place is set, and is exactly as dangerous.
  expect(seen.config).toBe(configDir)
  expect(seen.projects).toBe(projectsRoot)
  expect(seen.settings).toBe(claudeSettingsPath)
  expect(seen.socket).toBe(SOCKET)
  await app.close()
})
```

`app.evaluate` runs in the main process and its callback receives Electron's module object; reading `process.env` inside it needs no argument. This test opens no tmux session and costs no pty.

- [ ] **Step 2: Run** — `npx playwright test tests/e2e/launch.spec.ts`. Expect 4 green (3 + this one).

- [ ] **Step 3: A/B** — twice, and both matter. This is the task's actual deliverable; without it Step 1 is a test that reads four environment variables and agrees with itself.
  (a) Delete `PRCLI_CLAUDE_SETTINGS` from `launch.spec.ts`'s `env`; confirm the Step 1 test fails on `settings`. Note that this mutation *also* reddens `e2eSafety.test.ts` — that is the shipped guard working, and it is the half already covered. Restore by `cp`.
  (b) Change it to `PRCLI_CLAUDE_SETTINGS: claudeSettingsPath + '-typo'`; confirm the Step 1 test **still** fails **and `e2eSafety.test.ts` stays green**. That divergence is the entire justification for this task's continued existence: the token check cannot see a wrong path, and this test can. Without (b) the assertion could have been `expect(seen.settings).toBeTruthy()` and nobody would know.

---

### Task 3: One harness, one package, one place the overrides are named

`launch()`, `killServer()` and `sessionNames()` are copy-pasted four times with small drifts — which is *how* Task 2's hole opened. And `npm run package` runs in four separate `beforeAll` hooks, so a full run packages the app four times.

**This task breaks `tests/unit/e2eSafety.test.ts`, and must fix it in the same commit.** That guard enumerates `tests/e2e/*.spec.ts` and asserts each one contains the token `PRCLI_CLAUDE_SETTINGS:` (and the other three). `harness.ts` is not a `.spec.ts`, so it is never enumerated — and Step 3 below deletes the `PRCLI_*:` lines from all four specs, replacing them with a `claudeSettings:` argument that is a different string entirely. Left alone, this task takes the unit suite from **846 to 845** and does it in the name of *improving* safety. Verified at `5ba3abf` by reading `e2eSafety.test.ts`'s `readdirSync`/`endsWith('.spec.ts')` filter and its `source.includes(\`${envVar}:\`)` check.

The guard is not wrong and must not be deleted. What changes is *where the four vars now live*, so what it checks has to change with them — Step 4 below.

**Files:**
- Create: `tests/e2e/harness.ts`, `tests/e2e/global-setup.ts`
- Modify: `playwright.config.ts`, all four spec files, `tests/unit/e2eSafety.test.ts`

**Interfaces:**
- Produces `launchApp(opts: { socket: string; configDir: string; projectsRoot: string; claudeSettings: string; userDataDir: string }): Promise<ElectronApplication>`
- Produces `killServer(socket: string): Promise<void>` and `sessionNames(socket: string): Promise<string[]>`
- `global-setup.ts` default-exports `async (): Promise<void>` running `npm run package` once.

- [ ] **Step 1: Write `harness.ts`**

```ts
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The one place the app is launched from.
 *
 * Every one of the four overrides is REQUIRED, not optional-with-a-default.
 * Three of the four spec files went without `PRCLI_CLAUDE_SETTINGS` until
 * 2026-08-02, which meant a single added click on `hooks-install` would have
 * rewritten the developer's real ~/.claude/settings.json. A required
 * parameter is the fix; a default would restore the hole with better manners.
 */
export async function launchApp(opts: {
  socket: string
  configDir: string
  projectsRoot: string
  claudeSettings: string
  userDataDir: string
}): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${opts.userDataDir}`],
    env: {
      ...process.env,
      PRCLI_CONFIG_DIR: opts.configDir,
      PRCLI_TMUX_SOCKET: opts.socket,
      PRCLI_PROJECTS_ROOT: opts.projectsRoot,
      PRCLI_CLAUDE_SETTINGS: opts.claudeSettings,
    },
  })
}

/**
 * Destroy one test server. `-L` is not optional and never has been: a bare
 * `kill-server` would take every session the user has open with it.
 */
export async function killServer(socket: string): Promise<void> {
  await run('tmux', ['-L', socket, 'kill-server']).catch(() => undefined)
}

export async function sessionNames(socket: string): Promise<string[]> {
  try {
    const { stdout } = await run('tmux', ['-L', socket, 'list-sessions', '-F', '#{session_name}'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}
```

- [ ] **Step 2: Write `global-setup.ts` and wire it**

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Build once per run, not once per spec file.
 *
 * This rewrites `.vite/build/main.js` and `.vite/renderer/`. If a dev build
 * (`npm start`) is running, its main bundle — which has the Vite dev server URL
 * baked in — is replaced by a production one under it. The running process has
 * already loaded it and is unharmed, but the next `npm start` rebuilds from
 * scratch. Measured on 2026-08-01: the dev bundle carried
 * `http://localhost:5174`; after `npm run package` it did not.
 */
export default async function globalSetup(): Promise<void> {
  await run('npm', ['run', 'package'], { maxBuffer: 32 * 1024 * 1024 })
}
```

`maxBuffer` because `execFile` buffers all of forge's output and the default is 1 MB.

In `playwright.config.ts`, add `globalSetup: './tests/e2e/global-setup.ts'`, and delete the four `test.beforeAll(async () => { await run('npm', ['run', 'package']) })` hooks.

- [ ] **Step 3: Convert the four spec files**

Replace each file's local `launch`, `killServer`, `sessionNames` with imports from `./harness`, keeping each file's own `const SOCKET`. Per-file sockets stay: `workers: 1` makes them redundant today, but they are the only thing that would keep two files apart if that ever changed, and they cost nothing.

Each file's local wrapper becomes:

```ts
const launch = (): Promise<ElectronApplication> =>
  launchApp({ socket: SOCKET, configDir, projectsRoot, claudeSettings: claudeSettingsPath, userDataDir })
```

so the call sites in the tests do not change.

- [ ] **Step 4: Move the safety guard to where the vars now are — same commit, not a follow-up**

`tests/unit/e2eSafety.test.ts` currently asks "does every spec set all four?". After Step 3 the answer is no, correctly, because the specs no longer set any of them — `harness.ts` does. Rewrite the guard to ask the question that is now the right one, keeping its two existing properties: **enumeration** (so a fifth spec is still covered the day it lands) and the **comment strip** (so a comment mentioning a var cannot satisfy it).

The shape that preserves both, and the reasoning to put in its header:

1. **`harness.ts` sets all four.** A single `it` reading `tests/e2e/harness.ts` and asserting each of the four `VAR:` tokens is present. One place, one assertion.
2. **No spec launches Electron on its own.** This is what actually replaces the old per-spec check, and it is the stronger claim: enumerate `tests/e2e/*.spec.ts` as before and assert that **no** spec contains `electron.launch` or `_electron`. A spec that imports `launchApp` inherits all four vars by construction and needs no token check; a spec that reaches for `electron.launch` directly has stepped around the harness and is exactly the fifth-spec hazard the original guard existed to catch. Keep the `expect(specs.length).toBeGreaterThan(0)` assertion first, for the same `[].every(...)` reason it was written for.
3. **`launchApp`'s options are required, not optional.** Already true of the signature in Step 1 and enforced by `tsc`; say so in the header rather than asserting it twice.

Net unit count: **846 stays 846** if the two `it`s above replace the two that are there. If you land a different number, say which and why in the commit — a count that moves silently is how a guard gets quietly weakened.

**Do not** simply add `harness.ts` to the enumerated list and leave the per-spec check in place. That reintroduces the check the refactor exists to make unnecessary, and it would fail for every spec.

- [ ] **Step 5: Run the whole suite** — `npm run e2e`. Expect 35 green (34 + Task 2's). Expect it to be **faster**, because `npm run package` now runs once. Then `npx vitest run tests/unit` — **846**, with the guard rewritten, not deleted.

- [ ] **Step 6: A/B** — three, because this task has three separate failure modes.
  (a) Make `launchApp` pass `PRCLI_CONFIG_DIR: '/nonexistent/prcli'`; confirm tests fail rather than quietly writing elsewhere. Restore by `cp`.
  (b) Make `globalSetup` return without running `npm run package`, and `rm .vite/build/main.js`; confirm the suite fails to launch rather than passing against a stale build. **Restore `.vite/build/main.js` by re-running `npm run package`, not by `git checkout`** — it is gitignored and git has no copy of it.
  (c) **The new guard's own A/B.** Delete `PRCLI_CLAUDE_SETTINGS` from `harness.ts`'s `env` and confirm the rewritten `e2eSafety.test.ts` goes red; then restore it and instead add a bare `electron.launch(...)` call to any spec and confirm the second `it` goes red. Restore by `cp`. Without (c), a guard was rewritten and nobody checked the rewrite can fail — which is the shape of the twenty.

---

### Task 4: Make a failure legible

`playwright.config.ts` sets `testDir`, `timeout`, `workers` and `fullyParallel` and nothing else. No reporter, no trace, no screenshot, no retries. When this suite next fails on a machine nobody is watching, it will produce a line of text.

**Files:**
- Modify: `playwright.config.ts`, `.gitignore`

**Interfaces:** none.

- [ ] **Step 1: Make sure the reporter's output is ignored, before turning the reporter on**

`['html', { open: 'never' }]` writes a `playwright-report/` directory at the repo root. At `bf65c26` `.gitignore` had `test-results/` and **not** `playwright-report/`, so this task as drafted would have left an untracked directory behind and tripped its own `git diff` / clean-tree gate — and every later task's, since the reporter stays on.

`playwright-report/` was added to `.gitignore` on the `e2e-plan-revision` branch, ahead of this task, with a comment saying why. **Check it is there before Step 2** (`grep playwright-report .gitignore`); if that branch was never merged, add it here, in this task's commit.

- [ ] **Step 2: Add artefacts on failure only**

```ts
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  globalSetup: './tests/e2e/global-setup.ts',
  // Electron launches one app instance per worker. Serial is not only about
  // tmux state: every file's `beforeEach`/`afterEach` kills its own tmux
  // server outright, so two files running at once would tear down each
  // other's sessions if they ever shared a socket.
  workers: 1,
  fullyParallel: false,
  // No retries. A flaky E2E test that passes on retry is a test that has
  // stopped saying anything, and this repo has twenty of those already.
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
})
```

`video: 'off'` is explicit rather than defaulted: an Electron video is large, and a suite that writes one per test is a suite people stop running.

- [ ] **Step 3: Run** — `npm run e2e`. Confirm green, confirm nothing new appears under `test-results/`, and confirm `git status` is clean — `playwright-report/` will now exist on disk and must not show up.

- [ ] **Step 4: A/B** — introduce a deliberate failure (in a spec, not production: change one expected string in `launch.spec.ts`), run that file, and confirm a trace **and** a screenshot land under `test-results/`. Restore the spec by `cp`. This is the only A/B in the plan that mutates a test rather than production code, because the deliverable *is* what happens on failure.

---

### Task 5: Decide what to do with anything Task 1 found

Placeholder by design, and it must not be skipped. If Task 1's mutations left any test standing that should have fallen, this is where it is fixed — by tightening the assertion, never by deleting the test — or escalated.

**Files:** whichever spec Task 1 named.

- [ ] **Step 1:** For each survivor, write the assertion that would have failed. Prefer asserting a *value* over asserting *visibility*: `toBeVisible()` on a selector that is always in the DOM is the classic can't-fail shape, and `terminal-active` is always present the moment any tab exists.
- [ ] **Step 2:** Re-run Task 1's mutation for that file and confirm the tightened test now fails.
- [ ] **Step 3:** Restore by `cp`; `git diff` on production files empty.
- [ ] **Step 4:** If a survivor's *feature has changed shape* rather than its assertion being weak — a test about closing a tab, when close now closes a pane — **do not decide alone.** It goes to Open Questions.

---

### Task 6: A split, seen for the first time

Everything from here is **new coverage**, not revival. Tasks 1–5 leave the suite trustworthy; 6–8 point it at M2c.

Three facts, all verified against the code at `5ba3abf`, all easy to get wrong in a snippet:

- **`[data-testid^="pane-"]` is ambiguous.** `pane-divider`, `pane-restart-*`, `pane-dismiss-*` and `pane-dot-*` all match it. A pane *box* must be selected as a direct child of the group container: `:scope > [data-testid^="pane-"]`. Confirmed against `App.tsx:690-712`: the pane boxes are direct children of the `terminal-active` div, and the dividers overlay (`dividers-${group.id}`, `App.tsx:802`) is a sibling container that holds the `pane-divider` strips — so `:scope >` excludes them and a plain descendant selector would not.
- **A split is a second tmux session, not a tmux split-window.** `SessionManager.splitTab` calls `groupNameOf` and makes a new session in the same session group, with its own window. So after ⌘D, `sessionNames()` returns **two** names, one per pane, and each pane's size is that session's own `#{window_width}`.
- **The tab bar lists PANES, one entry each — so `[data-testid^="tab-"]` counts 2 after a split, not 1.** `TabBar.tsx:38-43` maps `currentTabs`, which is `tabsOfProject(state, …)` over `state.panes`, into `data-testid={\`tab-${tab.id}\`}`. `stateOfPane`'s doc in `workspace.ts` says it outright: *"the tab bar lists panes, one entry each, so its dots answer for a pane and not for the tab around it."* **This plan's first draft asserted `toHaveCount(1)` on that selector after a ⌘D, in both Task 6 and Task 7. Both are deleted, not repaired.** There is no count of `tab-*` that discriminates a split from two tabs — after a split it is 2, and after opening a second tab it is also 2. The claim "one tab, two panes" is already carried, correctly, by the `:scope >` selector finding both boxes inside a single `terminal-active`; adding a tab-bar count on top of it would have been a second assertion saying nothing, and it would have failed on a correct app.

**Files:**
- Create: `tests/e2e/splits.spec.ts` (socket `prcli-e2e-splits`)

**Interfaces:**
- Local helper `paneIds(window): Promise<string[]>` returning the active group's pane ids in on-screen order.

- [ ] **Step 1: The file's spine**

Copy `tabs.spec.ts`'s `beforeEach`/`afterEach`/`seedProject` shape, import `launchApp`/`killServer`/`sessionNames` from `./harness`, and add:

```ts
/** The active group's pane boxes, in on-screen order, as bare pane ids. */
async function paneIds(window: Page): Promise<string[]> {
  const boxes = window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]')
  // Non-empty first: `.map` over nothing is `[]`, and `[]` compares equal to
  // itself in every assertion that would otherwise catch a broken selector.
  await expect(boxes.first()).toBeVisible()
  return (await boxes.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).dataset.testid ?? ''),
  )).map((id) => id.replace('pane-', ''))
}
```

- [ ] **Step 2: The test**

```ts
test('⌘D splits the active tab into two panes, in one tab, with two sessions', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const before = await paneIds(window)
  expect(before).toHaveLength(1)

  await window.keyboard.press('Meta+d')

  // Two boxes in ONE group. That is the whole claim of a split, and the raw
  // pane count alone would not make it — two tabs would also give two boxes,
  // in two groups. The `:scope >` inside `terminal-active` is what carries it:
  // both boxes are direct children of the single visible group container.
  await expect(
    window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
  ).toHaveCount(2)

  // A split is a second tmux SESSION in the same session group, not a
  // split-window. `manager.splitTab` makes the window itself.
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  const after = await paneIds(window)
  expect(after).toContain(before[0])
  expect(after.filter((id) => id !== before[0])).toHaveLength(1)

  // The pane the user asked for is the one the keyboard talks to, and the
  // ring only appears where there is a choice to make.
  await expect(window.getByTestId(`pane-${after[1]}`)).toHaveAttribute('data-active', 'true')
  await expect(window.getByTestId(`pane-${after[0]}`)).toHaveAttribute('data-active', 'false')

  // ⌥⌘← moves the selection back along the tab's axis.
  await window.keyboard.press('Alt+Meta+ArrowLeft')
  await expect(window.getByTestId(`pane-${after[0]}`)).toHaveAttribute('data-active', 'true')

  await app.close()
})
```

`Meta+d` and `Alt+Meta+ArrowLeft` are the right form: `App.tsx`'s handler reads `event.code` (`KeyD`, `ArrowLeft`) precisely because ⌥ rewrites `event.key` on macOS, and `tabs.spec.ts` already drives `Alt+Meta+1` this way successfully.

- [ ] **Step 3: The split that is refused — the cheapest owed item in the backlog**

`App.tsx:191-196` refuses a ⌘D that cannot give the new pane its floor:

```ts
const wouldBe = axis === 'row' ? half(grid.cols) : half(grid.rows)
const floor = axis === 'row' ? MIN_PANE_COLS : MIN_PANE_ROWS
if (wouldBe < floor) {
  setError(`Not enough room to split: a pane needs at least ${floor} ${axis === 'row' ? 'columns' : 'rows'}`)
  return
}
```

and that `setError` surfaces at `data-testid="startup-error"` (`App.tsx:673`). **This has been owed since plan 2c and has never been checked by anything.** It is in this task rather than in a plan of its own because it is the cheapest owed item in the whole backlog: it needs **one pane, not two**, so it costs a single tmux session, and it is the only test here that a pty-starved machine has a chance of running.

```ts
test('⌘D on a pane too narrow to halve is refused, and says why', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()

  // Squeeze the window until half of it is under MIN_PANE_COLS (20). The
  // width in PIXELS is not the quantity the guard tests — it tests
  // `grid.cols`, which is what Terminal.tsx's fit reports — so this resizes
  // and then waits for the pane's own reported geometry rather than assuming
  // a pixel width maps to a column count.
  //
  // JUDGEMENT CALL FOR PAOLO, flagged rather than decided: how to get the
  // window small enough. Playwright cannot resize an Electron BrowserWindow
  // through the page API; it has to go through `app.evaluate` and
  // `BrowserWindow.getAllWindows()[0].setSize(...)`. That is a main-process
  // reach-in this suite does nothing else like. The alternative is to launch
  // this one test with a small window from the start, which needs a
  // `launchApp` option and touches the harness Task 3 just froze. Pick one
  // before implementing; do not do both.

  await window.keyboard.press('Meta+d')

  // Refused: still one box, and the reason is on screen. Asserting the TEXT,
  // not just visibility of `startup-error` — `toBeVisible` on an element that
  // only exists when `error` is set is close to honest, but the message names
  // the floor and the axis, and a guard that fired for the wrong axis would
  // still be visible.
  await expect(window.getByTestId('startup-error')).toContainText('at least 20 columns')
  await expect(
    window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
  ).toHaveCount(1)
  // And no second session was made — the refusal is BEFORE the IPC call.
  expect(await sessionNames(SOCKET)).toHaveLength(1)

  await app.close()
})
```

- [ ] **Step 4: Run** — `npx playwright test tests/e2e/splits.spec.ts`.

- [ ] **Step 5: A/B** — four, because these tests make four separate claims.
  (a) In `App.tsx`'s key handler, change `event.code === 'KeyD'` to `'KeyG'`; confirm the pane count assertion fails. (b) Delete the `dispatch({ type: 'activatedTab', id: active })` that follows `splitPane`; confirm the `data-active` assertion fails. (c) In `workspace.ts`'s `paneInDirection`, return `undefined` unconditionally; confirm the ⌥⌘← assertion fails and **nothing else in the file does**. (d) In `App.tsx`, change `if (wouldBe < floor)` to `if (false)`; confirm Step 3's test fails — on the session count and the box count, not only on the missing message, since a guard that stops setting the error but still returns early would pass a message-only assertion. Restore by `cp` each time.

---

### Task 7: A tombstone, on screen

`DeadPane` renders `dead-*`, `pane-restart-*` and `pane-dismiss-*`. No test in the repo has ever rendered it.

**Files:**
- Modify: `tests/e2e/splits.spec.ts`

**Interfaces:**
- Local helper `panePid(session: string)` — `tmux -L SOCKET list-panes -t '=<session>:' -F '#{pane_pid}'`. `tests/integration/pane-death.test.ts` uses the same shape; borrow it rather than inventing one.

- [ ] **Step 1: The test**

```ts
test('a killed pane leaves a tombstone where it was, and its tab keeps the other pane', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.keyboard.press('Meta+d')
  await expect(
    window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
  ).toHaveCount(2)
  const [left, right] = await paneIds(window)

  const victim = `prcli-scratch-${right}`
  expect(await sessionNames(SOCKET)).toContain(victim)
  await run('kill', ['-9', await panePid(victim)])

  // The box stays where it was and the overlay draws over it. A pane that
  // vanished — or that reappeared at the end of the row — is the regression
  // this pins, so the ORDER is asserted, not just the count.
  await expect(window.getByTestId(`dead-${right}`)).toBeVisible({ timeout: 20_000 })
  expect(await paneIds(window)).toEqual([left, right])
  await expect(window.getByTestId(`pane-${left}`)).toBeVisible()

  // Restart brings a live session back under the same pane id.
  await window.getByTestId(`pane-restart-${right}`).click()
  await expect(window.getByTestId(`dead-${right}`)).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  await app.close()
})
```

- [ ] **Step 2: Run** — `npx playwright test tests/e2e/splits.spec.ts`. This and Task 8 Step 3 are the only tests in the plan that kill a real process; run the file alone and **count resource errors before believing a failure**. A starved `posix_spawnp` on the restart reads exactly like a restart that did not work — and under the pty precondition at the top of this document, starvation is the *default* hypothesis, not the exotic one.

- [ ] **Step 3: A/B**

**(a) as drafted cannot fail, and the reason matters more than the fix.** The draft said: make `withKeptPanes`' dead-pane reinsertion append rather than restore position, and watch `toEqual([left, right])` fail. Traced at `5ba3abf`, it cannot:

- `withKeptPanes` runs from exactly two places — `applyTabShape` (`workspace.ts:830`, reached by `split`) and the `closedPane` case (`workspace.ts:1071`). Both are "main sent a new row for this tab".
- The `died` case (`workspace.ts:1037-1041`) does **none** of that. It is one line: `return { ...state, dead: { ...state.dead, [action.id]: action.code } }`. The row is untouched.
- So at the point the draft asserts, the on-screen order comes from `boxesOfRow` walking the row main already had, in `kids` order. No merge has happened, and mutating the merge cannot move it.

**And the obvious repair does not work either.** Moving the assertion after the restart click was the suggested alternative; it is wrong for the same class of reason. Restart goes `restartTab` → `window.prcli.restartTab({ tab })` → `dispatch({ type: 'opened', tab: restarted })` (`App.tsx:432-448`), and the `opened` case (`workspace.ts:958-975`) replaces the pane in `state.panes` and deletes it from `state.dead`. **It does not touch `state.tabs` and never calls `withKeptPanes`.**

Keep the order assertion — it is the right assertion and it pins a real regression — and give it one of these two A/Bs instead. **Both are legitimate; pick one and say which in the commit:**

- **Mutate what actually produces the order.** In `boxesOfRow` (`workspace.ts:557-583`), sort `kept` so tombstoned entries go last, or walk `row.layout.kids` in reverse. Either moves the dead box off its slot and fails `toEqual([left, right])` while the box count stays 2 — which is the point of asserting order. This is the honest A/B for the assertion as written.
- **Reach `withKeptPanes` on purpose, by extending the test.** After the tombstone exists, press ⌘D again on `left`. That is a `split`, which sends a new row, which runs `applyTabShape` → `withKeptPanes` → the successor-anchored `splice` whose comment says a tombstone restored to its old absolute index gives `[aaa, bbb, new, ccc]` instead of `[aaa, new, bbb, ccc]`. Assert that order, then the append mutation is a real A/B for it. **Costs a third tmux session** — read the pty precondition at the top before choosing this one.

**(b) is fine as drafted.** Unwire `pane-restart-*`'s `onRestart`; confirm the last two assertions fail. Restore by `cp`.

---

### Task 8: The drag — the thing none of this repo can see

The payoff. **Three of the three items `dividers.test.ts` still declares itself blind to are here** — that a pointerdown starts a drag and a pointerup ends one, where the divider lands, and that the pane follows the cursor / stops at the floor / reflows tmux behind it. The header's other two remaining items — the cursor changing, and React actually calling the effect's cleanup — are not covered here either, and Step 6 says so.

The draft's sentence *"everything the header declares it cannot see is here, except the two items reserved for Open Questions"* is cut: three of that header's six items have since been covered by `workspace.test.ts`, and the Open Question that reserved one of the other two has been answered by the tombstone-membership plan landing. Step 3 now covers what was reserved.

`page.mouse.move/down/up` in Chromium dispatches pointer events as well as mouse events, which is what `PaneDivider`'s `onPointerDown` and its window `pointermove`/`pointerup` listeners need. **Move before pressing** — a `mouse.down()` at the wrong coordinates presses on whatever is under (0, 0).

**Files:**
- Modify: `tests/e2e/splits.spec.ts`

**Interfaces:**
- Local helper `savedRatio(tabId: string)` reading `config.tabs.find(r => r.id === tabId)?.layout.ratio` out of `join(configDir, 'config.json')`. The field names are `layout.dir`, `layout.ratio`, `layout.kids` — verified in `store.ts` and `src/shared/ipc.ts`. A tab row's `id` is its **founder pane's id**, so it is `left` from Task 7's helper, not a separate tab id.
- Local helper `windowCols(session: string): Promise<number>`. **`tabs.spec.ts`'s `windowSize` returns a STRING of the shape `'197x48'`** (`tabs.spec.ts:88-94`, `'#{window_width}x#{window_height}'`), so `Number(await windowSize(...))` is `NaN` — and every `toBeGreaterThan(NaN)` is false, which makes the poll around it capable of nothing but timing out. This plan's first draft made exactly that mistake in Step 1 and then noted the helper's shape in a trailing paragraph without fixing the snippet. Write the numeric helper explicitly and use it everywhere:

```ts
/** Just the column count, as a number. `windowSize` in tabs.spec.ts returns '197x48'. */
async function windowCols(session: string): Promise<number> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${session}:`, '#{window_width}',
  ])
  return Number(stdout.trim())
}
```

Do not lift `windowSize` into `harness.ts` and change its return type — `tabs.spec.ts` uses the `'WxH'` string and would break silently. Two helpers, two names, one of them numeric.

- [ ] **Step 1: The divider moves the panes**

```ts
test('dragging the divider moves the seam, reflows tmux, and is written down on release', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await window.keyboard.press('Meta+d')
  await expect(
    window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
  ).toHaveCount(2)
  const [left, right] = await paneIds(window)

  // Exactly one divider for two panes, and it is scoped to the active group
  // so a hidden tab's overlay cannot be the one that is grabbed.
  const divider = window.getByTestId('terminal-active').getByTestId('pane-divider')
  await expect(divider).toHaveCount(1)

  const seamBefore = (await divider.boundingBox())!
  const leftBefore = (await window.getByTestId(`pane-${left}`).boundingBox())!
  const colsBefore = await windowCols(`prcli-scratch-${left}`)
  // Non-NaN first: every `toBeGreaterThan` below is false against NaN, so a
  // helper returning one turns the poll into a guaranteed timeout wearing the
  // costume of a failed assertion.
  expect(Number.isFinite(colsBefore)).toBe(true)

  await window.mouse.move(seamBefore.x + seamBefore.width / 2, seamBefore.y + seamBefore.height / 2)
  await window.mouse.down()
  // Two moves, not one: `PaneDivider` reports CUMULATIVE travel from the
  // pointerdown, and `dragPane` applies it to the ratio captured at `onGrab`.
  // A single move cannot tell a cumulative implementation from an incremental
  // one — the second move is what makes the two disagree.
  await window.mouse.move(seamBefore.x + 60, seamBefore.y + seamBefore.height / 2)
  await window.mouse.move(seamBefore.x + 120, seamBefore.y + seamBefore.height / 2)

  // Asserted mid-gesture, before the release: the pane follows the cursor
  // live, which is the claim, rather than snapping into place on mouse-up.
  await expect
    .poll(async () => (await window.getByTestId(`pane-${left}`).boundingBox())!.width)
    .toBeGreaterThan(leftBefore.width + 80)

  await window.mouse.up()

  // tmux reflows behind it, through Terminal.tsx's existing ResizeObserver.
  // A wider box that never reached tmux is a pane drawing over a session that
  // is still 80 columns, which is the bug this catches.
  await expect
    .poll(async () => await windowCols(`prcli-scratch-${left}`), { timeout: 20_000 })
    .toBeGreaterThan(colsBefore)

  // And written down, on release, to the founder pane's tab row.
  //
  // Polled as a POSITIVE condition. The first draft polled
  // `.not.toEqual([0.5, 0.5])`, which a missing row satisfies on the first
  // tick: `savedRatio` returns `undefined` when no row matches `left`, and
  // `undefined` is not equal to `[0.5, 0.5]`. So a `left` that named the
  // wrong pane — the exact failure a broken `paneIds` produces — would have
  // passed instantly. `?.[0]` keeps that shape while making the assertion one
  // only a real, larger, written-down share can satisfy.
  await expect
    .poll(async () => (await savedRatio(left))?.[0] ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0.5)

  // The one persistence assertion with teeth, kept. The two that were here
  // with it are DROPPED, because they are true by construction and cannot
  // discriminate anything:
  //   - `expect(saved).toHaveLength(2)` — `routeShares` builds `ratio` as
  //     `savedKids.map(...)`, so its length IS the row's kid count, always.
  //   - `expect(saved[0] + saved[1]).toBeCloseTo(1)` — the same `ratio` is
  //     each kid's share divided by the saved kids' own total, so it sums to
  //     1 by construction, whatever the drag sent. `sharesAroundClaims` has
  //     the same property on the tombstone path.
  // Both would have passed under every mutation in Step 4, including (e).
  // See `src/main/ipc/shares.ts:210-290`.
  const saved = await savedRatio(left)
  expect(saved?.[0]).toBeGreaterThan(0.5)

  await app.close()
})
```

- [ ] **Step 2: The floor pins, and un-pins**

```ts
test('a drag stops at the floor, and the same gesture reversed reopens the pane', async () => {
  // ... same setup through `divider` ...
  const seam = (await divider.boundingBox())!
  const rightBefore = (await window.getByTestId(`pane-${right}`).boundingBox())!

  await window.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2)
  await window.mouse.down()
  // Far past the right-hand pane's floor — MIN_PANE_COLS is 20, and this
  // shoves the seam most of the way across the window.
  await window.mouse.move(seam.x + rightBefore.width * 2, seam.y + seam.height / 2)

  // Settled, then asserted plainly. `expect.poll` returns on its first match
  // and so cannot assert that a pane STOPPED — it would pass on any frame
  // during which the pane was still moving.
  await window.waitForTimeout(300)
  const pinned = (await window.getByTestId(`pane-${right}`).boundingBox())!
  expect(pinned.width).toBeGreaterThan(0)
  expect(pinned.width).toBeLessThan(rightBefore.width / 2)

  // Reverse without releasing: the clamp is on the MOVEMENT, so a pane held
  // at its floor must reopen the moment the gesture comes back.
  await window.mouse.move(seam.x - rightBefore.width / 2, seam.y + seam.height / 2)
  await expect
    .poll(async () => (await window.getByTestId(`pane-${right}`).boundingBox())!.width)
    .toBeGreaterThan(pinned.width + 40)
  await window.mouse.up()

  await app.close()
})
```

- [ ] **Step 3: The drag on a tab holding a tombstone — the highest-value test in this plan**

**The first draft declined this, on a premise that is now false.** It reasoned that `CHANNELS.setLayout`'s length guard (`if (ratio.length !== saved.layout.kids.length) return`) silently swallows every drag on a tombstoned tab, so an E2E test would only pin a bug. **That guard no longer exists.** At `5ba3abf` the handler is `(tabId, shares: Record<paneId, number>)` (`register.ts:742`), membership is routed by name through `layoutWrite`/`routeShares`, and a drag on a tombstoned tab now reaches `register.ts:756-758`:

```ts
for (const entry of routed.owed) {
  tombstones.set(entry.id, { tabId, share: entry.share })
}
```

That `owed` write is declared **unwitnessed** in main's own notes. It is the one path where the renderer wins on a tombstone's share, it is reachable by a user in about four seconds, and nothing anywhere executes it. Task 7 already builds the tombstone; this adds a drag and a restart to it. **This is the single highest-value addition available to this plan** — it is why the drag-on-a-tombstone bullet has been removed from *Deliberately not in this plan* and from Open Question 2.

```ts
test('a drag on a tab holding a tombstone is kept, and the tombstone comes back at its new share', async () => {
  // ... Task 7's setup, through the kill, to `dead-${right}` visible ...
  // Three panes, so the tombstone is not the whole of one side of the seam:
  // split `left` first, THEN kill the middle pane. Costs two sessions after
  // the kill — see the pty precondition.

  const divider = window.getByTestId('terminal-active').getByTestId('pane-divider').first()
  const seam = (await divider.boundingBox())!
  await window.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2)
  await window.mouse.down()
  await window.mouse.move(seam.x + 100, seam.y + seam.height / 2)
  await window.mouse.up()

  // Main kept it. Under the OLD length guard this poll would have timed out
  // on a row still reading its pre-drag ratio, which is what the first draft
  // predicted and declined to assert.
  await expect
    .poll(async () => (await savedRatio(left))?.[0] ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0.5)

  // And the tombstone's own claim survived the round trip: restart it and the
  // pane comes back at the width the drag left it, not at an even share.
  // This is the assertion that witnesses `tombstones.set` — nothing else in
  // the repo does. It is the reason this test exists.
  const deadBox = (await window.getByTestId(`pane-${dead}`).boundingBox())!
  await window.getByTestId(`pane-restart-${dead}`).click()
  await expect(window.getByTestId(`dead-${dead}`)).toHaveCount(0, { timeout: 20_000 })
  await expect
    .poll(async () => (await window.getByTestId(`pane-${dead}`).boundingBox())!.width)
    .toBeGreaterThan(0)
  const revived = (await window.getByTestId(`pane-${dead}`).boundingBox())!
  // Within a few pixels of where it was: the claim was written, read back and
  // honoured. An even split would put it at a third of the tab.
  expect(Math.abs(revived.width - deadBox.width)).toBeLessThan(12)

  await app.close()
})
```

**Two things to settle while implementing, both flagged rather than decided:**
- **Three panes or two?** Written above for three, so the tombstone is not one whole side of the only seam and the drag has a live pair to move. Two panes — one live, one dead — may not present a grabbable divider at all: `grabFor` refuses when `boxes.length !== row.layout.kids.length`, and whether a tombstoned kid keeps the row's length through this sequence has not been traced. Three costs a third session. **Trace the two-pane case before assuming it works; if it does, prefer it for the pty budget.**
- **The 12px tolerance is a guess.** It has not been measured against a real window. If it flakes, widen it and say so — do not convert it to a directional assertion, because "wider than zero" is exactly what an even split would also satisfy.

- [ ] **Step 4: Run** — `npx playwright test tests/e2e/splits.spec.ts`.

- [ ] **Step 5: A/B — five, and this is the task where they earn their keep.** Each targets something no other test in the repo executes.
  (a) In `App.tsx`, change the `offset` sum's `slice(0, index)` to `slice(0, index - 1)` (`App.tsx:811`). `dividers.test.ts` stays 11/11 green — confirm **this** test fails, on `seamBefore` landing at the tab's leading edge.
  (b) Replace the strip's `` `${offset * 100}%` `` with a constant `0%` (`PaneDivider.tsx:144`). Same: confirm E2E fails where the unit suite does not.
  (c) **Rewritten — as drafted it could not fail.** The draft said: make `dragPane` apply the delta to the *current* ratio instead of the grabbed one, and watch the two-move assertion fail. It cannot. Compounding **overshoots in the same direction** — two moves of +60 and +120 give roughly +180 instead of +120 — and the assertion is a *lower* bound (`toBeGreaterThan(leftBefore.width + 80)`). Both the correct implementation and the compounding one clear it. The mutation is worth keeping; the assertion has to be able to see it. Either:
    - assert the final width **equals** the grabbed ratio plus the cumulative cursor delta, within a stated pixel tolerance — an equality, so an overshoot fails it; or
    - **add a third move** and assert linearity in cursor travel: the width gained from move 2 to move 3 equals the width gained from move 1 to move 2, for equal cursor steps. A cumulative implementation is linear in travel; a compounding one is not.

    The second is window-size independent and is the recommendation. Whichever is chosen, **it changes Step 1's snippet**, not just this A/B — a lower bound alone leaves (c) inert.
  (d) **Citation corrected, and the argument replaced.** The floor derivation is no longer in `App.tsx`: it moved to `grabFor`, and reads `const axisCells = gridCells / low.share` at **`src/renderer/workspace.ts:446`**. Turn that `/` into a `*` and confirm Step 2's floor assertion fails. **The draft's justification is dead** — it said the unit suite's `minRatioFor(` token assertion passes either way, which was true at `bf65c26` and is not true now: `dividers.test.ts`'s current header states that both this mutation and the argument swap are caught by `workspace.test.ts`'s `measures a col tab down the other axis, against the other floor`. So this A/B no longer demonstrates *unique* E2E coverage. Keep it anyway, for a smaller and honest reason: it confirms the E2E test is wired to the real floor arithmetic rather than to a coincidence of window size. Expect **two** suites to go red, and record that, rather than reporting a unit failure as a surprise.
  (e) In `register.ts`, delete the `store.write` inside `CHANNELS.setLayout`; confirm the `savedRatio` assertion fails. **The draft's claim that "this is the first test anywhere that reaches past the IPC call to what main does with it" is false and is cut**: `tests/integration/persistence.test.ts` drives `ipc.listeners.get(CHANNELS.setLayout)` directly at eleven call sites (1405, 1578, 1631, 1654, 1666, 1716, 1873, 1955, 2051, 2095, …) and asserts what reaches disk. The mutation is still a good A/B — it is just not novel, and expect the integration suite to go red alongside. What *is* novel here is Step 3's `owed` write, which persistence.test.ts's addendum at line 2035 names as the one place it exercises and which no test drives through a real gesture.
  Restore by `cp` after each; `git diff src/renderer/App.tsx src/renderer/workspace.ts src/renderer/PaneDivider.tsx src/main/ipc/register.ts` empty before committing.

- [ ] **Step 6: Declare what this still does not cover**

At the top of `splits.spec.ts`, in the house style. At minimum:

- **It drags a `row` tab only.** Never a `col` tab, and (outside Step 3) never three or more panes, so the seam-placement arithmetic is exercised at its easiest point — the `n − 1.5` pixel error `PaneDivider`'s comment derives is invisible here.
- **It asserts that tmux got *wider*, not that it got wider by the right amount.**
- **It does not discharge the owed manual verification, and must not be read as doing so.** Two independent reasons, and both hold even with every test in this task green. The `col` axis stays entirely unwatched — every drag here is horizontal, and the floor, the seam arithmetic and the reflow all take the other branch on a `col` tab. And a `boundingBox()` measurement is not a human watching a window: it cannot see tearing, a divider that jumps before it tracks, a cursor that does not change, an xterm that redraws at the wrong size for a frame, or any of the things a person notices in the first half-second. What this task buys is that the gesture is **wired, monotone, floored and persisted**. What it leaves owed is that the gesture **looks right**, on both axes. Those are different claims and only the first is testable here.
- **No assertion read off the rendered panes can witness a uniform rescale of main's row — so "the row sums to 1" must never be checked on screen.** `withKeptPanes` divides the incoming shares by their own sum (`workspace.ts:770-773`) and `boxesOfRow` divides each kept share by the kept total (`workspace.ts:568,575`). Both normalise. A row of `[0.6, 0.4]` and a row of `[6, 4]` render identically, pixel for pixel. Any on-screen assertion about the row summing to 1 is therefore true by construction and can fail for nothing — it belongs in `workspace.test.ts`, where the vector itself is visible, and it is dropped from Step 1 for exactly this reason.
- **The tmux-reflow assertion rests on something never measured, and is recorded as unmeasured rather than assumed.** Step 1 reads `#{window_width}` off two sessions that are in the same **session group**. Sessions in a group *share a window list*, and tmux sizes a shared window per attached client. How that interacts with two Electron-attached clients showing two panes of one split — whether each session reports its own client's width, or both report a shared minimum — **has never been measured on this project.** If Step 1's reflow poll times out, that is the first hypothesis, ahead of any renderer bug. **Measure it the day ptys return, before running Task 8:** attach two clients to a grouped pair at different sizes and read `#{window_width}` off each. One `tmux` command, and it decides whether this assertion means what it says.
- **`grabPane`'s three refusal guards.** Still executed by nothing here — though they are no longer uncovered generally: they moved into `grabFor` and are pinned by `workspace.test.ts`. What stays uncovered is a *user gesture* reaching them.

---

## Deliberately not in this plan

- **CI.** Whether this suite should run anywhere but a developer's Mac is the author's call, not mine — see Open Questions. Nothing here assumes a CI runner exists.
- **Pinning or upgrading Playwright.** `@playwright/test` and `playwright-core` are both `1.62.0`, exactly pinned in `package.json`, and Electron `43.2.0` launches under them today — measured, 35 launches. There is no version problem to fix, so this plan does not invent one.
- ~~**Fixing the `setLayout` length guard.**~~ **Cut, because the guard is gone.** This bullet said `register.ts` silently drops a drag on any tab holding a tombstone, that this was a product defect, and that Task 8 deliberately stopped one step short of it. All three were true at `bf65c26`. The tombstone-membership work landed in between: `CHANNELS.setLayout` now takes named shares (`register.ts:742`), routes membership by name through `layoutWrite`, and has no length guard to trip. There is nothing left to decline — so **Task 8 Step 3 now covers the path this bullet was protecting**, and covers it as correct behaviour rather than as a pinned bug, which is what the draft rightly refused to write.
- **Two-dimensional drag, arbitrary nesting, detach-a-pane-to-a-tab.** Out of M2c entirely.
- **Replacing the static `dividers.test.ts` check.** It stays. It is fast, it runs on every `npm test`, and its measured non-coverage list is the best documentation of this gesture in the repo. E2E complements it; it does not retire it. Note that the list is now *shorter* than when this plan was drafted — three of its six items moved into `workspace.test.ts` — which is the file doing its job, not rot.
- **A `col`-axis drag.** Named in Task 8 Step 6 as uncovered rather than quietly omitted, and named there as one of the two reasons this plan does **not** discharge the owed manual verification. A natural follow-up once Task 8 has proved the shape works.
- **A three-pane drag, in the general case.** Still declined — but Task 8 Step 3 may build a three-pane tab for the tombstone test, in which case the setup exists and only an assertion is missing. See the flagged judgement call below on the conservation assertion, which turns on exactly this.
- **The `n − 1.5` pixel seam error.** `PaneDivider`'s own comment derives it; nothing here measures it, and a two-pane row is the one arrangement where it is invisible.

## Open questions — for the author, not for the implementer

Please settle these before Task 5 and Task 8 are executed. Nothing below is a decision an agent should make alone.

1. **Should E2E run in CI at all?** It needs a real Mac, a real tmux, a real display for Electron, and `npm run package`. It costs 47 seconds and no ptys, which is cheap — but "cheap" assumes the machine has tmux and a windowing session. If the answer is no, say so and I will add "runs on a developer's machine, on request" to the config comment so nobody wires it up by accident.
2. ~~**The `setLayout` tombstone bug.**~~ **Answered by events — no longer a question.** This asked whether Task 8 should pin, as a known-failing test, the length guard that silently discarded every drag on a tombstoned tab. The tombstone-membership plan landed between the draft and this revision and removed the guard: `CHANNELS.setLayout` now takes `(tabId, shares: Record<paneId, number>)` and routes membership by name. There is no bug to decide about pinning. The judgement in the original — *"a test that asserts a bug is correct is worse than no test"* — was right and is preserved above the change; what it applied to has gone. **Task 8 Step 3 now tests the path as correct behaviour**, and finds something better there: `register.ts:756-758`'s `tombstones.set` is an `owed` write that main's own notes declare unwitnessed, and no test drives it through a real gesture. That is the highest-value thing E2E can now catch, and it is in the plan rather than in an open question.
3. **Should any spec be deleted or reshaped?** `tabs.spec.ts` has `closing a tab destroys its session` and `the keyboard opens, switches and closes tabs`, both written when a tab was one pane. Close now closes a *pane*, and `App.tsx` wires the tab bar's × to `closePane`. Those tests still pass because their tabs are one-pane — which means they now test a special case while reading like they test the general one. Tighten, rename, or leave with a header saying so? I have left them alone and reserved the call.
4. **Retries.** I set `retries: 0` on the argument that a test which passes on retry has stopped saying anything. If you would rather have `retries: 1` locally to absorb an occasional slow tmux attach, say so — but then the `flaky` count becomes something someone has to read every run.
5. **Should Task 8 land in this plan or its own?** It is new coverage, not revival, and it is the largest task here. My judgement is that it belongs: it is the entire reason this plan exists, no other plan would carry it, and Tasks 1–5 without it leave the suite trustworthy but still blind to M2c. If you disagree, cut 6–8 into `2026-08-03-prcli-e2e-splits-coverage.md` and this becomes a clean five-task revival.
6. **The dev-build collision.** Running E2E while `npm start` is up replaces `.vite/build/main.js` under the dev build. Task 3 documents it. Would you rather it *refuse* — a `globalSetup` that throws if an Electron dev process is running? That is safer and also more annoying.

## Self-review

**What this plan claims, and what was measured.** The suite is green (ran it, 34/34, 47.6s). It allocates no net ptys (422 `/dev/ttys*` before, 422 after, twice). It was last run Jul 31 11:07 (`test-results/.last-run.json` mtime, matching the four stale socket mtimes). Nothing has rotted at the selector level (every `getByTestId` in all four specs cross-checked against `grep -rho 'data-testid=...' src/`; the two suspicious ones, `preset-marker` and `project-unsorted`, are template-generated and correct). The four sockets are per-file constants, read from the code. No bare `kill-server` exists. `PRCLI_CLAUDE_SETTINGS` was set in `status.spec.ts` alone — **that was true on 2026-08-01 and is the finding this plan is proudest of; it is no longer true, because it was fixed at `b12416b` in response to this plan.** Real `~/.prcli` and `~/.claude/settings.json` mtimes were checked before and after the run and neither moved.

**Everything in the paragraph above was measured on 2026-08-01 against `bf65c26`. None of it has been re-measured at `5ba3abf`, and it cannot be until the machine has ptys** — the E2E suite has not been run since. Treat the 34/34, the 47.6s and the zero-net-pty result as the last known state rather than as current fact. The selector cross-check and the socket constants were re-read at `5ba3abf` and still hold; the runtime numbers were not.

**Revival vs new coverage.** Tasks 1–5 are revival (audit, safety, harness, diagnosability). Tasks 6–8 are new coverage. Open Question 5 gives the author a clean cut line if he disagrees.

**Ordering.** 1 first, because everything after it rests on the existing tests meaning something. 2 before 3 because it is one test and should not wait behind a refactor — and because its A/B (b) is what proves the shipped token guard has a gap worth a runtime assertion, which is the premise Task 3's rewrite of that guard depends on. 3 before 4 (the config gains `globalSetup` in 3 and reporters in 4, one file, two reasons). 5 after 1–4 so a survivor is fixed against a harness that will not move again. 6 before 7 before 8 — a tombstone needs a split, and Task 8's tombstone drag needs Task 7's tombstone recipe as well as Task 6's split.

**One ordering defect this plan had, now fixed in place rather than reordered.** Task 3 moves the four env vars out of the specs and into `harness.ts`. `tests/unit/e2eSafety.test.ts` — which landed *after* this plan was drafted, in response to Task 2 — enumerates `tests/e2e/*.spec.ts` and asserts each one contains the four `VAR:` tokens. So Task 3 as drafted takes the unit suite from **846 to 845**, in the name of improving safety, and nothing in the plan mentioned it. Task 3 now carries Step 4 to rewrite the guard in the same commit. This is the clearest example on this project of a premise changing under a plan while the plan slept: the guard did not exist when Task 3 was written, and Task 3 breaks it.

**Pre-flight, run against the real code before this plan was finished.** Five defects in my own snippets, each caught by reading the source rather than trusting memory:

- **`[data-testid^="pane-"]` does not select pane boxes.** `pane-divider`, `pane-restart-*`, `pane-dismiss-*` and `pane-dot-*` all match it. Every snippet now uses `:scope > [data-testid^="pane-"]` inside `terminal-active`. This would not have failed to compile — it would have silently over-counted, which is worse.
- **A split is not a tmux split-window.** `SessionManager.splitTab` creates a second *session* in a session group via `groupNameOf`, with its own window. My first draft asserted `list-panes` count on one session and would have been wrong about the app's whole architecture. `sessionNames()` returns one name per pane.
- **A tab row's `id` is its founder pane's id.** There is no separate tab id to read; `savedRatio(left)` takes the founder's pane id. This is the same confusion the 2c plan's own pre-flight caught.
- **`CHANNELS.setLayout` is `ipcMain.on`, not `handle`.** Nothing to await, so every persistence assertion polls the config file rather than awaiting a promise. Task 8 Step 1 does.
- **`getByTestId('terminal')` is the *pane's* xterm container** (`Terminal.tsx`), while `terminal-active` is the *group* container (`App.tsx`). `launch.spec.ts` uses the former and is safe only because its tabs are one-pane; the moment a split exists in that file it resolves to two elements and Playwright refuses it. Named in Task 1's header work rather than fixed, because `launch.spec.ts` never splits.

Helpers referenced by name were checked to exist with that signature: `windowSize(name)` and `savedActiveTabId()` in `tabs.spec.ts`; `panePid` modelled on `tests/integration/pane-death.test.ts`; `formatHookLine`, `HOOK_EVENTS`, `DEFAULT_NOTIFICATIONS` imported by `status.spec.ts` today. `MIN_PANE_COLS` is 20 and `MIN_PANE_ROWS` is 5, both `App.tsx`. Keyboard forms (`Meta+d`, `Alt+Meta+ArrowLeft`) match `App.tsx`'s `event.code` checks and the `Alt+Meta+1` form `tabs.spec.ts` already drives successfully.

**Second pre-flight, 2026-08-02, against `5ba3abf`.** The list above was thorough and still missed these. Every one was confirmed by reading the code, not by trusting the review that reported it; each is corrected at its own task, and this is the index:

| # | Defect | Where | Severity |
|---|---|---|---|
| D1 | `toHaveCount(1)` on `[data-testid^="tab-"]` after ⌘D. The tab bar lists **panes**, one entry each — after a split it is 2. **Dropped, not repaired**: no `tab-*` count discriminates a split from two tabs, and the `:scope >` selector already carries the claim. | Tasks 6, 7 | blocking |
| D2 | `Number(await windowSize(...))` is `NaN` — the helper returns `'197x48'`. Every `toBeGreaterThan` is false, so the poll can only time out. The draft's trailing note spotted the helper shape and then did not fix the snippet. | Task 8 Step 1 | blocking |
| D3 | A/B (c) cannot fail: a compounding `dragPane` **overshoots in the same direction**, and the assertion is a lower bound. Needs an equality or a linearity assertion — which changes Step 1, not only the A/B. | Task 8 | can't-fail |
| D4 | A/B (d) cited `grid.cols / low.share` in `App.tsx`; it is `gridCells / low.share` in `grabFor` (`workspace.ts:446`), and its stated justification — "the unit suite passes either way" — is dead, because `workspace.test.ts` now catches it. | Task 8 | wrong citation, dead argument |
| D5 | A/B (a) targets `withKeptPanes`, which runs only from `applyTabShape` and `closedPane`. The `died` case sets `state.dead[id]` and nothing else, so at the point asserted no merge has happened. **The obvious repair is also wrong** — restart dispatches `opened`, which never calls `withKeptPanes` either. | Task 7 | can't-fail |
| D6 | `.poll(() => savedRatio(left)).not.toEqual([0.5, 0.5])` — a missing row returns `undefined`, which satisfies it on the first tick, so a wrong `left` passes instantly. Replaced with a positive condition. | Task 8 Step 1 | can't-fail |
| D7 | Two of three persistence assertions true by construction: `routeShares` builds `ratio` as `savedKids.map(...)`, so its length is the kid count and it sums to 1 whatever the drag sent. Only `saved[0] > 0.5` had teeth. Both dropped. | Task 8 Step 1 | near-inert |
| D8 | "The first test anywhere that reaches past the IPC call to what main does with it" is false — `persistence.test.ts` drives `CHANNELS.setLayout` at eleven call sites and asserts to disk. Mutation kept, claim cut. | Task 8 A/B (e) | false claim |
| D9 | `['html', { open: 'never' }]` writes `playwright-report/`, which was not in `.gitignore` — Task 4 would have tripped its own clean-tree gate, and every later task's. | Task 4 | blocking |
| D10 | The `KeyW`→`KeyQ` row also breaks `projects.spec.ts:307`. "Exactly one fails" is file-scoped, and the header built on it must say so. | Task 1 | overstated claim |

Two of the ten (D3, D6) and one of the originals share a shape worth naming: **an assertion that is directionally right and cannot fail.** A lower bound that an overshoot also satisfies, and a negated poll that `undefined` satisfies, are the same defect wearing different syntax. That shape is what produced most of the twenty.

**Known soft spots, stated rather than hidden.**
- Task 8's assertions are directional — wider, greater than — not exact. Layout arithmetic depends on the window size Electron happens to give the test, and an exact assertion would be flaky rather than strict. The A/B mutations are what make the direction load-bearing; without them Step 1 is close to a can't-fail test, and that is said here so nobody skips them. **D3 and D6 are what happens when this trade is made carelessly** — a lower bound and a negated poll are both "directional", and neither could fail. Directional is a licence to be imprecise, not a licence to be unfalsifiable, and the difference is whether a *wrong* implementation clears the bar.
- Task 8 Step 2's floor test settles with `waitForTimeout(300)`. A fixed sleep is the honest tool for "assert it stopped", but it is a fixed sleep, and on a loaded machine 300ms may not be enough. If it flakes, raise it — do not convert it to a poll, which cannot express "stopped" at all.
- Task 1's mutation table is the foundation of this plan and I could not run it: this investigation was forbidden from modifying source. It is derived from reading, and Step 5 exists to make the implementer verify one row of it before trusting the rest — the controller review argues for all four, which is unruled. If the `tabs.spec.ts` row does not reproduce, stop and re-derive the table rather than proceeding. **And read D10 first**: that row's blast radius is one test *in its own file*, and two in the suite.
- **The pty budget is now the binding constraint, not a caveat.** On the night this was drafted it was tight (511 max, 422 allocated). On 2026-08-02 it is exhausted — `pty.openpty()` raises, 643 fds across 179 processes, 429 of them `zsh`. See the precondition at the top; nothing in this plan can run until a reboot. If, after the reboot, any task fails with `posix_spawnp failed`, `fork failed: Device not configured`, or an assertion reading `expected '' to be …`, **count those before believing it is a defect** — and count them inside assertion text, not only in error lines. Task 7 and Task 8 Step 3 are the pty-hungry tests; Step 3 may want three sessions.
- **Nothing in this revision has been executed.** Every correction above was made by reading the code at `5ba3abf`, exactly as the original pre-flight was, and is subject to exactly the same failure mode — which is why every task still ends in an A/B.

## Controller review of this draft — recommendations, not rulings (2026-08-02)

Discussed with Paolo; he has not yet ruled on any of it. Recorded so the discussion is not lost.

**Three changes I would make to the plan before executing it:**

1. **Task 1 Step 5: verify all four mutation rows, not one.** The table is this plan's
   foundation and was derived by reading rather than running — the self-review says so.
   Verifying one row and trusting three is sampling, and sampling is how fifteen dead
   tests reached this repo. Four rows cost about 30 seconds of runtime.
2. **Task 8: add a conservation assertion.** "The left pane gets wider" passes even if the
   drag moved the wrong pair in the right direction — which is exactly M2c 2c's CT-2, a
   pane nobody touched changing width. Assert that the two adjacent panes move by equal
   and opposite amounts and that every other pane is unchanged. Still window-size
   independent, so it adds no flake.

   > **FLAGGED FOR PAOLO — this recommendation asserts nothing at the size Task 8 is
   > written, and the two ways out are a real choice.** Checked at `5ba3abf`:
   > `resizeKids` moves share between exactly two adjacent kids by construction, so on a
   > **two-pane row** the "equal and opposite" half is arithmetic restating itself, and
   > the "every other pane is unchanged" half has no other pane to quantify over — it is
   > `[].every(...)`, which the Global Constraints forbid by name. The recommendation
   > only bites at **three or more panes**, which Task 8 declines. So:
   >
   > - **(A) Add a three-pane drag** and make the conservation assertion the reason for
   >   it. Cost: a third tmux session per test that uses it, and one more `⌘D` in setup;
   >   under the current pty precondition, that is not free. Buys the one assertion that
   >   can see CT-2's shape — a pane nobody touched changing width — which is a defect
   >   class this project has actually shipped. Note that Task 8 Step 3 may already build
   >   a three-pane tab for the tombstone test, in which case the marginal cost is one
   >   assertion, not one session.
   > - **(B) Drop the recommendation** and say in Task 8 Step 6 that conservation is
   >   untested and why. Honest, free, and leaves the CT-2 shape uncovered by anything.
   >
   > **Not decided here.** Adding a three-pane drag changes what this plan is for; the
   > *Deliberately not in this plan* section declines it in as many words, and reversing
   > that is the author's call. If (A): also decide whether it lives in Step 1 or in its
   > own test. If (B): Step 6's non-coverage list needs a line, and this recommendation
   > should be struck rather than left standing unactioned.
3. ~~**Task 2/3: land the override where it cannot be forgotten.**~~ **Half done, half
   still open.** The first half shipped: all four specs now set all four vars
   (`b12416b`), and `tests/unit/e2eSafety.test.ts` fails if one is missing. Task 3 does
   move the override into `harness.ts` as the single place, and now says so explicitly —
   along with the ordering defect that follows from it, which this recommendation did not
   anticipate: the shipped guard enumerates `*.spec.ts` and would go red the moment the
   override leaves the specs. Task 3 Step 4 rewrites it in the same commit.

   The second half is **still open and still the stronger fix**: make
   `claudeSettingsPath()` refuse the `homedir()` fallback when a test env var is set, so
   the guard sits at the write rather than at the launch. That is a **product change**,
   which this plan is otherwise scoped not to make. **Paolo's call**, and out of scope
   until he makes it.

**Recommended answers to the Open Questions above:**

1. CI — **no**. Say so in the config so nobody wires it up by accident.
2. ~~`setLayout` tombstone bug — **its own plan, ahead of this one.**~~ **This
   recommendation was taken, and the plan it asked for has already landed.** It said the
   bug deserved its own plan ahead of this one, because a live defect losing user work
   outranks reviving a suite that already passes. That plan is
   `docs/superpowers/plans/2026-08-02-prcli-tombstone-membership.md`, and it merged at
   `5ba3abf`. The guard is gone; the channel now names its panes. Nothing here is
   outstanding — see the rewritten Open Question 2 for what took its place.
3. `tabs.spec.ts` — **rename and header now, reshape later.** A test that reads like the
   general case and exercises a special one is the same family as the dead tests.
4. `retries: 0` — **agree.** A test that passes on retry has stopped saying anything.
5. Keep 6-8 together — Task 8 needs 6 and 7 for setup. But 1-2 are the urgent half.
6. **Make it refuse.** It already replaced a running dev build's bundle once.

**Open, and Paolo's call:** whether E2E revival is still the next thing at all. It was
queued when the suite was believed broken. It is green. ~~M2c 2c's CT-1 and CT-2 are real
defects in code that landed last night, and this plan explicitly declines to touch them.~~

**That closing sentence is now stale, and its premise is what the question turned on.**
CT-1 — every drag on a tombstoned tab silently discarded — was fixed by the
tombstone-membership plan, merged at `5ba3abf`. **CT-2 — a pane nobody touched changing
width — I have not confirmed either way**, and I am not asserting it fixed: `ad94158` and
`9055089` both work in that area, but tracing whether the reported symptom is gone needs
more than reading two commit subjects, and this revision was scoped to the document.
**Flagged for Paolo rather than answered.**

What that does to the question: the strongest argument *against* doing this plan next has
weakened, and the strongest argument *for* it has strengthened. Task 8 Step 3 now exists
because the fix landed — it tests `register.ts:756-758`'s `owed` write, which main's own
notes call unwitnessed, through a real user gesture. So the plan no longer declines to
touch the thing that outranked it; it covers it. **The genuine blocker is now
operational, not editorial: the machine cannot open a pty.** See the precondition at the
top.
