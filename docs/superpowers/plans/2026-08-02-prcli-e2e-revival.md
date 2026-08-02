# PRCLI E2E Revival — the suite is alive; make it trustworthy, then make it see a drag

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Playwright suite from a thing nobody runs into the one mechanism in this repo that can watch a human use the app — and then point it at the M2c surface no test anywhere can currently see: splits, tombstones, and the drag gesture.

**Base:** `m2c-plan2c-drag-resize` at `bf65c26`.

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

`tests/unit/dividers.test.ts` covers the drag gesture by reading `App.tsx` and `PaneDivider.tsx` as *text*, because `vitest.config.mts` runs `environment: 'node'` — there is no DOM, and its own header explains that a DOM would not be enough either, since jsdom performs no layout and `offsetWidth` and a percentage `left` would both report nothing about the thing at stake. That header then lists, in the author's own words, what it cannot see. Quoting the list rather than paraphrasing it, because it is the argument:

- *"that a pointerdown starts a drag at all, or that a pointerup ends one"*
- *"where the divider lands"* — and, measured: replacing `slice(0, index)` with `slice(0, index - 1)` draws every divider one seam early, the first flush against the tab's leading edge, and **eleven of eleven assertions still pass**. So does replacing `${offset * 100}%` with a constant `0%`, which stacks every divider in the app at that edge.
- *"that a pane follows the cursor 1:1 over a long drag, that it stops at the floor, or that the tmux session reflows behind it"*
- *"`grabPane`'s refusal guards — … the subtlest logic in this whole change and nothing anywhere executes it: measured, deleting all three leaves this file eleven of eleven green"*
- *"the floor derivation — `axisCells = grid.cols / low.share` … swapping its two arguments passes, and so does turning that `/` into a `*`"*
- *"that main actually persists what this handler sends"* — `CHANNELS.setLayout`'s length guard in `register.ts` (`if (ratio.length !== saved.layout.kids.length) return`) drops a ratio silently on **any tab holding a tombstone**, which is reachable in ordinary use and which nothing in the repo executes.

The header closes: *"A human with the app open is the only thing that sees any of those."* That is true today, and it does not have to stay true. A working E2E suite is the only mechanism in this repo that could ever cover a single item on that list. It exists, it is green, and it costs 47 seconds and no ptys. That is the whole argument.

## Architecture

Four spec files, one Electron app per test, `workers: 1`, `fullyParallel: false`. Each file owns a **different tmux socket** — confirmed from the `const SOCKET` at the top of each file, not from the socket names on disk:

| File | `SOCKET` | Tests |
|---|---|---|
| `tests/e2e/launch.spec.ts` | `prcli-e2e` | 3 |
| `tests/e2e/projects.spec.ts` | `prcli-e2e-projects` | 10 |
| `tests/e2e/status.spec.ts` | `prcli-e2e-status` | 10 |
| `tests/e2e/tabs.spec.ts` | `prcli-e2e-tabs` | 11 |

Every one of the 14 `kill-server` invocations under `tests/` is `-L`-scoped; there is no bare `kill-server` anywhere in the repo. The four stale sockets dated Jul 31 are exactly these four, left by the last run.

Each file duplicates `launch()`, `killServer()`, `sessionNames()` and a `beforeAll` that shells out to `npm run package`. That duplication is where the safety hole in Task 2 lives, and Task 3 removes it.

**Selector coupling is healthier than expected.** Every `getByTestId` the specs use resolves against current `src/renderer/`: `new-tab`, `terminal`, `terminal-active`, `tab-*`, `close-*`, `dot-*`, `sidebar`, `rightpanel`, `empty-state`, `add-project`, `candidate-*`, `project-*`, `pmenu-*`, `prename-*`, `premove-*`, `pdot-*`, `rename-input-*`, `smove-*`, `preset-*`, `needs-*`, `needs-you-count`, `restart-*`, `settings-open`, `hooks-status`, `hooks-install`, `hooks-uninstall`. Two that look like rot are not: `preset-marker` is `` `preset-${preset.label}` `` for a preset the spec itself declares, and `project-unsorted` is `` `project-${project.id}` `` for the synthetic Unsorted row. **No selector has rotted.** What has happened instead is that a large new selector surface — `pane-*`, `dividers-*`, `pane-divider`, `dead-*`, `pane-restart-*`, `pane-dismiss-*` — appeared in M2c and **no spec mentions any of it**.

## Global Constraints

- **E2E uses its own sockets only** (`prcli-e2e*`), the integration suite uses `-L prcli-test`, and **a bare `tmux kill-server` is forbidden anywhere** — it would destroy the user's real sessions.
- Tests never touch the real `~/.prcli` (`PRCLI_CONFIG_DIR`), `~/Code` (`PRCLI_PROJECTS_ROOT`), or `~/.claude/settings.json` (`PRCLI_CLAUDE_SETTINGS`). **All four overrides, in every launch, in every file** — see Task 2.
- **Never run `npm install` / `npm ci`.** It breaks node-pty's spawn-helper permissions and fails every integration test with `posix_spawnp failed`. Note that `npm run package` *does* run `@electron/rebuild` against `node_modules/node-pty` (the `build/Release/` tree dated Jul 31 07:47 is its output) and has not broken anything so far — but if the integration suite ever fails with `posix_spawnp failed` right after an E2E run, `node scripts/fix-node-pty-perms.js` is the first thing to try, not a reinstall.
- **Never weaken, delete or loosen a test assertion, timeout or poll interval to make something pass.** If an assertion contradicts the code, stop and report.
- **Never assert over a collection without first asserting it is non-empty.** `[].every(...)` is `true`.
- **`expect.poll` cannot assert the absence of a change.** It returns on its first match. Poll for a transition; settle then assert plainly for a non-change.
- **Every task ends with an A/B step:** break the production code the new assertion guards and confirm the test fails. This project has found **fifteen tests that could not fail**, and a green suite caught every one of them. An E2E suite is unusually prone to this — a spec that waits for a selector which always exists asserts nothing.
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

The suite passes. Nothing has established that it *can fail*. Fifteen tests in this repo could not, and every one of them was green. Before a single new assertion is written, the existing 34 have to be shown to be load-bearing.

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

- [ ] **Step 3: Any test that survived a mutation aimed squarely at it is a finding**

Write it down with the mutation that failed to move it. Do not fix it in this task and do not delete it — Task 5 decides what to do with it, and the Open Questions below reserve the delete/keep call for the author.

- [ ] **Step 4: Give each spec a declared-non-coverage header**

Follow `tests/unit/dividers.test.ts`'s house style: what the file covers, then a **What this file does NOT see** list, then measured edits that pass anyway. Use the Step 2 and Step 3 results — this header must be measurement, not guesswork. At minimum, each header states that the file drives a **one-pane tab only**, so nothing in it exercises `paneGroups`' multi-box branch, `boxesOfRow`, the dividers overlay, or `DeadPane`.

- [ ] **Step 5: A/B this task's own deliverable**

The header is prose and cannot fail. The deliverable that *can* is the mutation table: re-run one row (the `tabs.spec.ts` one) and confirm the recorded pass/fail split reproduces exactly. If it does not, the table is wrong and the header built on it is a comment asserting a mechanism that is not true.

---

### Task 2: `PRCLI_CLAUDE_SETTINGS` is set in one file out of four

**This is the serious finding, and it goes near the top for that reason.** `status.spec.ts` sets it, with a comment explaining that it must be set *even in tests that never open the settings pane* — "read by every live Claude session on this machine". `launch.spec.ts`, `projects.spec.ts` and `tabs.spec.ts` set `PRCLI_CONFIG_DIR`, `PRCLI_TMUX_SOCKET` and `PRCLI_PROJECTS_ROOT`, and **do not set `PRCLI_CLAUDE_SETTINGS`**. `install.ts`'s `claudeSettingsPath()` falls back to `join(homedir(), '.claude', 'settings.json')`, and `register.ts` wires `CHANNELS.installHooks` / `uninstallHooks` straight to functions that write it.

Nothing in those three files clicks `hooks-install` today, which is why the run above left the real file at its Jul 28 mtime. That is one assertion away from being false, in any file, at any time, and the blast radius is every Claude session on the machine.

**Files:**
- Modify: `tests/e2e/launch.spec.ts`, `tests/e2e/projects.spec.ts`, `tests/e2e/tabs.spec.ts`

**Interfaces:**
- Each file gains `claudeSettingsPath`, seeded in `beforeEach` and torn down in `afterEach` alongside the other temp dirs.

- [ ] **Step 1: Add the override to all three**

In each file, beside the existing `let configDir: string` declarations:

```ts
let claudeSettingsDir: string
let claudeSettingsPath: string
```

In `launch()`'s `env`, beneath `PRCLI_PROJECTS_ROOT`:

```ts
      // Read by every live Claude session on this machine. Set here even
      // though nothing in this file opens the settings pane: the fallback in
      // `claudeSettingsPath()` is the developer's real ~/.claude/settings.json,
      // and one added click is all that stands between this suite and writing
      // to it. `status.spec.ts` has carried this since 2b; the other three
      // files did not, which is what this closes.
      PRCLI_CLAUDE_SETTINGS: claudeSettingsPath,
```

In `beforeEach`, mirroring `status.spec.ts`:

```ts
  claudeSettingsDir = await mkdtemp(join(tmpdir(), 'prcli-e2e-claude-'))
  claudeSettingsPath = join(claudeSettingsDir, 'settings.json')
```

and add `claudeSettingsDir` to the `afterEach` cleanup array.

- [ ] **Step 2: Add the guard that makes the omission impossible to reintroduce**

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

- [ ] **Step 3: Run** — `npx playwright test tests/e2e/launch.spec.ts tests/e2e/projects.spec.ts tests/e2e/tabs.spec.ts`. Expect 4 + 10 + 11 = 25 green.

- [ ] **Step 4: A/B** — twice, and both matter.
  (a) Delete `PRCLI_CLAUDE_SETTINGS` from `launch.spec.ts`'s `env`; confirm the Step 2 test fails on `settings`. Restore by `cp`.
  (b) Change it to `PRCLI_CLAUDE_SETTINGS: claudeSettingsPath + '-typo'`; confirm it **still** fails. Without (b) the assertion could have been `expect(seen.settings).toBeTruthy()` and nobody would know.

---

### Task 3: One harness, one package, one place the overrides are named

`launch()`, `killServer()` and `sessionNames()` are copy-pasted four times with small drifts — which is *how* Task 2's hole opened. And `npm run package` runs in four separate `beforeAll` hooks, so a full run packages the app four times.

**Files:**
- Create: `tests/e2e/harness.ts`, `tests/e2e/global-setup.ts`
- Modify: `playwright.config.ts`, all four spec files

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

- [ ] **Step 4: Run the whole suite** — `npm run e2e`. Expect 35 green (34 + Task 2's). Expect it to be **faster**, because `npm run package` now runs once.

- [ ] **Step 5: A/B** — the risk here is a harness that silently launches nothing.
  (a) Make `launchApp` pass `PRCLI_CONFIG_DIR: '/nonexistent/prcli'`; confirm tests fail rather than quietly writing elsewhere. Restore by `cp`.
  (b) Make `globalSetup` return without running `npm run package`, and `rm .vite/build/main.js`; confirm the suite fails to launch rather than passing against a stale build. **Restore `.vite/build/main.js` by re-running `npm run package`, not by `git checkout`** — it is gitignored and git has no copy of it.

---

### Task 4: Make a failure legible

`playwright.config.ts` sets `testDir`, `timeout`, `workers` and `fullyParallel` and nothing else. No reporter, no trace, no screenshot, no retries. When this suite next fails on a machine nobody is watching, it will produce a line of text.

**Files:**
- Modify: `playwright.config.ts`

**Interfaces:** none.

- [ ] **Step 1: Add artefacts on failure only**

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
  // stopped saying anything, and this repo has fifteen of those already.
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

- [ ] **Step 2: Run** — `npm run e2e`. Confirm green and confirm nothing new appears under `test-results/`.

- [ ] **Step 3: A/B** — introduce a deliberate failure (in a spec, not production: change one expected string in `launch.spec.ts`), run that file, and confirm a trace **and** a screenshot land under `test-results/`. Restore the spec by `cp`. This is the only A/B in the plan that mutates a test rather than production code, because the deliverable *is* what happens on failure.

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

Two facts, both verified against the code and both easy to get wrong in a snippet:

- **`[data-testid^="pane-"]` is ambiguous.** `pane-divider`, `pane-restart-*`, `pane-dismiss-*` and `pane-dot-*` all match it. A pane *box* must be selected as a direct child of the group container: `:scope > [data-testid^="pane-"]`.
- **A split is a second tmux session, not a tmux split-window.** `SessionManager.splitTab` calls `groupNameOf` and makes a new session in the same session group, with its own window. So after ⌘D, `sessionNames()` returns **two** names, one per pane, and each pane's size is that session's own `#{window_width}`.

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

  // Two boxes in ONE group: the tab bar still shows a single entry. That is
  // the whole claim of a split, and the pane count alone does not make it —
  // two tabs would also give two boxes, in two groups.
  await expect(
    window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
  ).toHaveCount(2)
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

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

- [ ] **Step 3: Run** — `npx playwright test tests/e2e/splits.spec.ts`.

- [ ] **Step 4: A/B** — three, because this test makes three separate claims.
  (a) In `App.tsx`'s key handler, change `event.code === 'KeyD'` to `'KeyG'`; confirm the pane count assertion fails. (b) Delete the `dispatch({ type: 'activatedTab', id: active })` that follows `splitPane`; confirm the `data-active` assertion fails. (c) In `workspace.ts`'s `paneInDirection`, return `undefined` unconditionally; confirm the ⌥⌘← assertion fails and **nothing else in the file does**. Restore by `cp` each time.

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
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  // Restart brings a live session back under the same pane id.
  await window.getByTestId(`pane-restart-${right}`).click()
  await expect(window.getByTestId(`dead-${right}`)).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)

  await app.close()
})
```

- [ ] **Step 2: Run** — `npx playwright test tests/e2e/splits.spec.ts`. This is the only test in the plan that kills a real process; run the file alone and **count resource errors before believing a failure**. A starved `posix_spawnp` on the restart reads exactly like a restart that did not work.

- [ ] **Step 3: A/B** — (a) in `workspace.ts`, make the dead-pane reinsertion append rather than restore position; confirm the `toEqual([left, right])` assertion fails while the count assertion passes — which is the point of asserting order. (b) Unwire `pane-restart-*`'s `onRestart`; confirm the last two assertions fail. Restore by `cp`.

---

### Task 8: The drag — the thing none of this repo can see

The payoff. Everything the `dividers.test.ts` header declares it cannot see is here, except the two items reserved for Open Questions.

`page.mouse.move/down/up` in Chromium dispatches pointer events as well as mouse events, which is what `PaneDivider`'s `onPointerDown` and its window `pointermove`/`pointerup` listeners need. **Move before pressing** — a `mouse.down()` at the wrong coordinates presses on whatever is under (0, 0).

**Files:**
- Modify: `tests/e2e/splits.spec.ts`

**Interfaces:**
- Local helper `savedRatio(tabId: string)` reading `config.tabs.find(r => r.id === tabId)?.layout.ratio` out of `join(configDir, 'config.json')`. The field names are `layout.dir`, `layout.ratio`, `layout.kids` — verified in `store.ts` and `src/shared/ipc.ts`. A tab row's `id` is its **founder pane's id**, so it is `left` from Task 7's helper, not a separate tab id.

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
  const colsBefore = Number(await windowSize(`prcli-scratch-${left}`))

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
    .poll(async () => Number(await windowSize(`prcli-scratch-${left}`)), { timeout: 20_000 })
    .toBeGreaterThan(colsBefore)

  // And written down, on release, to the founder pane's tab row.
  await expect.poll(() => savedRatio(left), { timeout: 20_000 }).not.toEqual([0.5, 0.5])
  const saved = await savedRatio(left)
  expect(saved).toHaveLength(2)
  expect(saved[0]).toBeGreaterThan(0.5)
  expect(saved[0] + saved[1]).toBeCloseTo(1)

  await app.close()
})
```

`windowSize` is `tabs.spec.ts`'s existing helper (`display-message -p -t '=<name>:' '#{window_width}x#{window_height}'`); take the width half, or lift the helper into `harness.ts` and give it a `#{window_width}`-only form. Say which in the commit; do not leave two helpers with the same name and different return types.

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

- [ ] **Step 3: Run** — `npx playwright test tests/e2e/splits.spec.ts`.

- [ ] **Step 4: A/B — five, and this is the task where they earn their keep.** Each targets something `dividers.test.ts` explicitly measured itself blind to.
  (a) In `App.tsx`, change the `offset` sum's `slice(0, index)` to `slice(0, index - 1)`. `dividers.test.ts` stays 11/11 green — confirm **this** test fails, on `seamBefore` landing at the tab's leading edge.
  (b) Replace the strip's `` `${offset * 100}%` `` with a constant `0%`. Same: confirm E2E fails where the unit suite does not.
  (c) In `dragPane`, apply the delta to the *current* ratio instead of the grabbed one; confirm the two-move assertion in Step 1 fails and a one-move version would not have.
  (d) In `App.tsx`, turn `grid.cols / low.share` into `grid.cols * low.share`; confirm Step 2's floor assertion fails. The unit suite's `minRatioFor(` token assertion passes either way — measured, and stated in its own header.
  (e) In `register.ts`, delete the `store.write` inside `CHANNELS.setLayout`; confirm the `savedRatio` assertions fail. This is the first test anywhere that reaches past the IPC call to what main does with it.
  Restore by `cp` after each; `git diff src/renderer/App.tsx src/main/ipc/register.ts` empty before committing.

- [ ] **Step 5: Declare what this still does not cover**

At the top of `splits.spec.ts`, in the house style, at minimum: it drags a **two-pane row** only, never a `col` tab and never three or more panes, so the seam-placement arithmetic is exercised at its easiest point — the `n − 1.5` pixel error `PaneDivider`'s comment derives is invisible here. It never drags on a tab holding a tombstone (see Open Questions). It asserts that tmux got *wider*, not that it got wider by the right amount. And it says nothing about `grabPane`'s three refusal guards, which remain executed by nothing.

---

## Deliberately not in this plan

- **CI.** Whether this suite should run anywhere but a developer's Mac is the author's call, not mine — see Open Questions. Nothing here assumes a CI runner exists.
- **Pinning or upgrading Playwright.** `@playwright/test` and `playwright-core` are both `1.62.0`, exactly pinned in `package.json`, and Electron `43.2.0` launches under them today — measured, 35 launches. There is no version problem to fix, so this plan does not invent one.
- **Fixing the `setLayout` length guard.** `register.ts` silently drops a drag on any tab holding a tombstone. That is a **product defect**, and the M2c spec deferred E2E revival specifically on the grounds that it touches no product code. Task 8 stops one step short of it, deliberately; Open Questions carries it.
- **Two-dimensional drag, arbitrary nesting, detach-a-pane-to-a-tab.** Out of M2c entirely.
- **Replacing the static `dividers.test.ts` check.** It stays. It is fast, it runs on every `npm test`, and its measured non-coverage list is the best documentation of this gesture in the repo. E2E complements it; it does not retire it.
- **A `col`-axis or three-pane drag.** Named in Task 8 Step 5 as uncovered rather than quietly omitted. It is a natural follow-up once Task 8 has proved the shape works.

## Open questions — for the author, not for the implementer

Please settle these before Task 5 and Task 8 are executed. Nothing below is a decision an agent should make alone.

1. **Should E2E run in CI at all?** It needs a real Mac, a real tmux, a real display for Electron, and `npm run package`. It costs 47 seconds and no ptys, which is cheap — but "cheap" assumes the machine has tmux and a windowing session. If the answer is no, say so and I will add "runs on a developer's machine, on request" to the config comment so nobody wires it up by accident.
2. **The `setLayout` tombstone bug.** Every drag on a tab holding a tombstone is silently discarded by `if (ratio.length !== saved.layout.kids.length) return`. Task 8 could pin this today as a **known-failing** test, or as a test that asserts the *current* (wrong) behaviour, or not at all. I have chosen "not at all" — a test that asserts a bug is correct is worse than no test, and this plan is not supposed to touch product code. But it is the single most valuable thing E2E could now catch. Do you want it as a follow-up plan of its own, one that fixes the guard *and* covers it?
3. **Should any spec be deleted or reshaped?** `tabs.spec.ts` has `closing a tab destroys its session` and `the keyboard opens, switches and closes tabs`, both written when a tab was one pane. Close now closes a *pane*, and `App.tsx` wires the tab bar's × to `closePane`. Those tests still pass because their tabs are one-pane — which means they now test a special case while reading like they test the general one. Tighten, rename, or leave with a header saying so? I have left them alone and reserved the call.
4. **Retries.** I set `retries: 0` on the argument that a test which passes on retry has stopped saying anything. If you would rather have `retries: 1` locally to absorb an occasional slow tmux attach, say so — but then the `flaky` count becomes something someone has to read every run.
5. **Should Task 8 land in this plan or its own?** It is new coverage, not revival, and it is the largest task here. My judgement is that it belongs: it is the entire reason this plan exists, no other plan would carry it, and Tasks 1–5 without it leave the suite trustworthy but still blind to M2c. If you disagree, cut 6–8 into `2026-08-03-prcli-e2e-splits-coverage.md` and this becomes a clean five-task revival.
6. **The dev-build collision.** Running E2E while `npm start` is up replaces `.vite/build/main.js` under the dev build. Task 3 documents it. Would you rather it *refuse* — a `globalSetup` that throws if an Electron dev process is running? That is safer and also more annoying.

## Self-review

**What this plan claims, and what was measured.** The suite is green (ran it, 34/34, 47.6s). It allocates no net ptys (422 `/dev/ttys*` before, 422 after, twice). It was last run Jul 31 11:07 (`test-results/.last-run.json` mtime, matching the four stale socket mtimes). Nothing has rotted at the selector level (every `getByTestId` in all four specs cross-checked against `grep -rho 'data-testid=...' src/`; the two suspicious ones, `preset-marker` and `project-unsorted`, are template-generated and correct). The four sockets are per-file constants, read from the code. No bare `kill-server` exists. `PRCLI_CLAUDE_SETTINGS` is set in `status.spec.ts` alone. Real `~/.prcli` and `~/.claude/settings.json` mtimes were checked before and after the run and neither moved.

**Revival vs new coverage.** Tasks 1–5 are revival (audit, safety, harness, diagnosability). Tasks 6–8 are new coverage. Open Question 5 gives the author a clean cut line if he disagrees.

**Ordering.** 1 first, because everything after it rests on the existing tests meaning something. 2 before 3 because the hole is one line and should not wait behind a refactor. 3 before 4 (the config gains `globalSetup` in 3 and reporters in 4, one file, two reasons). 5 after 1–4 so a survivor is fixed against a harness that will not move again. 6 before 7 before 8 — a tombstone needs a split, and a drag on a tombstone-free tab needs the split to be known good.

**Pre-flight, run against the real code before this plan was finished.** Five defects in my own snippets, each caught by reading the source rather than trusting memory:

- **`[data-testid^="pane-"]` does not select pane boxes.** `pane-divider`, `pane-restart-*`, `pane-dismiss-*` and `pane-dot-*` all match it. Every snippet now uses `:scope > [data-testid^="pane-"]` inside `terminal-active`. This would not have failed to compile — it would have silently over-counted, which is worse.
- **A split is not a tmux split-window.** `SessionManager.splitTab` creates a second *session* in a session group via `groupNameOf`, with its own window. My first draft asserted `list-panes` count on one session and would have been wrong about the app's whole architecture. `sessionNames()` returns one name per pane.
- **A tab row's `id` is its founder pane's id.** There is no separate tab id to read; `savedRatio(left)` takes the founder's pane id. This is the same confusion the 2c plan's own pre-flight caught.
- **`CHANNELS.setLayout` is `ipcMain.on`, not `handle`.** Nothing to await, so every persistence assertion polls the config file rather than awaiting a promise. Task 8 Step 1 does.
- **`getByTestId('terminal')` is the *pane's* xterm container** (`Terminal.tsx`), while `terminal-active` is the *group* container (`App.tsx`). `launch.spec.ts` uses the former and is safe only because its tabs are one-pane; the moment a split exists in that file it resolves to two elements and Playwright refuses it. Named in Task 1's header work rather than fixed, because `launch.spec.ts` never splits.

Helpers referenced by name were checked to exist with that signature: `windowSize(name)` and `savedActiveTabId()` in `tabs.spec.ts`; `panePid` modelled on `tests/integration/pane-death.test.ts`; `formatHookLine`, `HOOK_EVENTS`, `DEFAULT_NOTIFICATIONS` imported by `status.spec.ts` today. `MIN_PANE_COLS` is 20 and `MIN_PANE_ROWS` is 5, both `App.tsx`. Keyboard forms (`Meta+d`, `Alt+Meta+ArrowLeft`) match `App.tsx`'s `event.code` checks and the `Alt+Meta+1` form `tabs.spec.ts` already drives successfully.

**Known soft spots, stated rather than hidden.**
- Task 8's assertions are directional — wider, greater than, not equal to `[0.5, 0.5]` — not exact. Layout arithmetic depends on the window size Electron happens to give the test, and an exact assertion would be flaky rather than strict. The five A/B mutations are what make the direction load-bearing; without them Step 1 is close to a can't-fail test, and that is said here so nobody skips Step 4.
- Task 8 Step 2's floor test settles with `waitForTimeout(300)`. A fixed sleep is the honest tool for "assert it stopped", but it is a fixed sleep, and on a loaded machine 300ms may not be enough. If it flakes, raise it — do not convert it to a poll, which cannot express "stopped" at all.
- Task 1's mutation table is the foundation of this plan and I could not run it: this investigation was forbidden from modifying source. It is derived from reading, and Step 5 exists to make the implementer verify one row of it before trusting the rest. If the `tabs.spec.ts` row does not reproduce, stop and re-derive the table rather than proceeding.
- The pty budget was not a constraint on this suite, but it was on the night this was written (511 max, 422 allocated). If any task here starts failing with `posix_spawnp failed`, `fork failed: Device not configured`, or an assertion reading `expected '' to be …`, **count those before believing it is a defect** — and count them inside assertion text, not only in error lines. Task 7 is the only pty-hungry test in the plan.

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
3. **Task 2/3: land the override where it cannot be forgotten.** Setting
   `PRCLI_CLAUDE_SETTINGS` in three spec files leaves four copies and a fifth spec that
   forgets it. Task 3 builds a harness anyway — state explicitly that Task 3 MOVES the
   override into it as the single place. Stronger still: make `claudeSettingsPath()`
   refuse the `homedir()` fallback when the test env is set, so the guard sits at the
   write rather than at four call sites.

**Recommended answers to the Open Questions above:**

1. CI — **no**. Say so in the config so nobody wires it up by accident.
2. `setLayout` tombstone bug — **its own plan, ahead of this one.** It is M2c 2c's CT-1:
   every drag on a tombstoned tab is silently discarded. A live defect losing user work
   outranks reviving a suite that already passes. Agree with refusing to assert a bug.
3. `tabs.spec.ts` — **rename and header now, reshape later.** A test that reads like the
   general case and exercises a special one is the same family as the dead tests.
4. `retries: 0` — **agree.** A test that passes on retry has stopped saying anything.
5. Keep 6-8 together — Task 8 needs 6 and 7 for setup. But 1-2 are the urgent half.
6. **Make it refuse.** It already replaced a running dev build's bundle once.

**Open, and Paolo's call:** whether E2E revival is still the next thing at all. It was
queued when the suite was believed broken. It is green. M2c 2c's CT-1 and CT-2 are real
defects in code that landed last night, and this plan explicitly declines to touch them.
