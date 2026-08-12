# Dev Server Browser Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A button in the terminal tab bar that opens a browser pane on the project's running dev server, or a blank pane when no server has announced itself.

**Architecture:** A pure scanner reads pty output for a loopback URL. Main already forwards every pty chunk at `src/main/ipc/register.ts:870`, so a registry hooks in there and files the most recent URL per project slug, in memory. The renderer asks for it when the button is pressed and passes it to `openBrowser`, which already accepts an optional URL.

**Tech Stack:** TypeScript, Electron, React, vitest, Playwright.

**Spec of record:** `docs/superpowers/specs/2026-08-12-dev-server-browser-button-design.md`

## Global Constraints

- **No em dashes anywhere**: code, comments, test names, commit messages. Use commas, colons, parentheses, or separate sentences. Before committing, grep the staged diff's added lines for U+2014 and quote the command and its output in the report. On the previous plan every em dash that shipped was caught by exactly that grep and by nothing else, including five that a green 2496-test suite and a clean typecheck could not see.
- **Comments must be true of the BRANCH, not just of the commit that writes them.** The dominant defect class in this codebase: ten instances on the previous plan, four written while correcting others. Measure every count, caller list, and "only"/"never"/"nothing" claim with a command at the final state.
- **Verification is by running.** Any claim that a test fails or passes must name the command and quote the observed output. A check whose success looks like absence (no button in the browser bar, no URL recorded for a public origin) must be shown to fail against a known violation before its silence counts as evidence.
- **There is one loopback predicate.** `isLoopbackUrl` in `src/shared/localOrigin.ts`. Do not write a second one.
- **The button's testid must not begin with `tab-`.** More than 27 e2e locators count tabs with `[data-testid^="tab-"]` and would silently inflate.
- **A peer Claude session may work in this checkout.** Run `git status --porcelain` before staging, stage only your own files by explicit path, never `git add -A`. The untracked `CLAUDE.md` is not yours.
- **Turn budget.** Keep any single command under about two minutes. A full `npm run e2e` is about four minutes and must be the only command in its turn. Reap stale servers first: `tmux -L pterm-test kill-server 2>/dev/null || true`. Never touch the `default` socket.

## Facts measured on 2026-08-12 that this plan depends on

- `window.pterm.openBrowser(projectId: string, url?: string)` already exists (`src/shared/ipc.ts:1455`), and main already honours the URL: `url: (url === undefined ? null : normaliseUrl(url)) ?? 'about:blank'` at `src/main/ipc/register.ts:2476`. **No task needs to add that parameter.**
- Main forwards every pty chunk at `src/main/ipc/register.ts:870`: `manager.onData((id, data) => send(CHANNELS.data, { id, data }))`. That line is the hook point.
- `TabBar` (`src/renderer/TabBar.tsx`) is shared by the terminal and browser columns and already takes `onNew` and a `newLabel` prop. Its `+` button is at line 426.
- A pane carries `projectSlug` (`src/shared/ipc.ts:332`), and `ProjectDescriptor` carries both `id` and `slug` (`:744-748`). `openBrowser` takes the project **id**; panes name the project **slug**. A task that files by one and reads by the other will look right and never match.
- There is no ANSI-stripping helper anywhere in `src/`. Task 1 writes the only one.

---

### Task 1: The scanner

**Files:**
- Create: `src/main/devserver/scan.ts`
- Create: `tests/unit/devServerScan.test.ts`

**Interfaces:**
- Consumes: `isLoopbackUrl` from `src/shared/localOrigin.ts`.
- Produces:
  - `export const SCAN_TAIL_BYTES: number`
  - `export function scanForLocalUrl(tail: string, chunk: string): { url: string | null; tail: string }`

`scanForLocalUrl` is pure. It takes the previous tail and a new chunk, and returns the last loopback URL visible in `tail + chunk` (or null) plus the new tail to carry forward.

- [ ] **Step 1: Write the failing tests**

Cover each of these. The first is the one that matters: a naive implementation passes every other test and fails this one, and that is exactly the shape that would ship a broken feature behind a green suite.

```ts
import { describe, expect, it } from 'vitest'
import { SCAN_TAIL_BYTES, scanForLocalUrl } from '../../src/main/devserver/scan'

describe('scanForLocalUrl', () => {
  it('finds a URL whose port is wrapped in ANSI escapes, as Vite prints it', () => {
    // Vite colours the port, so the escape codes sit INSIDE the URL text.
    const line = '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n'
    expect(scanForLocalUrl('', line).url).toBe('http://localhost:5173/')
  })

  it('finds a URL split across two chunks', () => {
    const first = scanForLocalUrl('', 'Local: http://localhos')
    expect(first.url).toBeNull()
    expect(scanForLocalUrl(first.tail, 't:3000/\r\n').url).toBe('http://localhost:3000/')
  })

  it('ignores a URL that is not loopback', () => {
    expect(scanForLocalUrl('', 'Network: https://example.com:5173/\r\n').url).toBeNull()
  })

  it('returns the last loopback URL when a chunk holds several', () => {
    const chunk = 'Local: http://localhost:3000/\r\nLocal: http://127.0.0.1:8080/\r\n'
    expect(scanForLocalUrl('', chunk).url).toBe('http://127.0.0.1:8080/')
  })

  it('keeps a bounded tail so a long silent stream cannot grow memory', () => {
    const { tail } = scanForLocalUrl('', 'x'.repeat(SCAN_TAIL_BYTES * 4))
    expect(tail.length).toBeLessThanOrEqual(SCAN_TAIL_BYTES)
  })
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/unit/devServerScan.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement, then run**

Strip ANSI before matching. Do not match the raw stream: the Vite test above is the proof of why.

Choose `SCAN_TAIL_BYTES` deliberately and state your reasoning in the code from something real (the longest URL this can reasonably need to reassemble), not from taste.

Run: `npx vitest run tests/unit/devServerScan.test.ts`
Expected: PASS, 5 of 5.

- [ ] **Step 4: Prove the ANSI test can fail**

Replace the strip with the identity function, re-run, and confirm the Vite test fails while the others still pass. Quote the output. Restore, re-run, confirm green. This asymmetry is the whole argument for stripping, and it should be recorded rather than asserted.

- [ ] **Step 5: Commit**

```bash
git add src/main/devserver/scan.ts tests/unit/devServerScan.test.ts
git commit -m "Find the URL a dev server announces in a pty stream"
```

---

### Task 2: The registry

**Files:**
- Create: `src/main/devserver/registry.ts`
- Create: `tests/unit/devServerRegistry.test.ts`

**Interfaces:**
- Consumes: Task 1's `scanForLocalUrl` and `SCAN_TAIL_BYTES`.
- Produces:
  - `export class DevServerRegistry` with:
    - `observe(paneId: string, projectSlug: string, chunk: string): void`
    - `urlFor(projectSlug: string): string | null`
    - `forget(paneId: string): void`

The registry holds, per project slug, the most recently announced URL and the pane that announced it. It holds a tail per pane. Nothing is persisted.

- [ ] **Step 1: Write the failing tests**

Cover: a chunk carrying a URL makes `urlFor` return it; a second pane in the same project announcing later replaces the first; a pane in a DIFFERENT project does not affect this project's answer; `forget` clears an entry whose pane announced it; `forget` on a pane that announced nothing leaves the answer alone; and `urlFor` on a project with nothing announced is null.

Write these as real calls against a real instance. No mocks: the registry has no collaborators worth faking.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/unit/devServerRegistry.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement, then run**

Keep it a plain class over two maps. Say in a comment why nothing here is persisted: a URL from a previous run is a lie the moment the server is gone, and a persisted one would open a dead port on the next launch.

Run: `npx vitest run tests/unit/devServerRegistry.test.ts`
Expected: PASS.

- [ ] **Step 4: Prove the cross-project test can fail**

Make `urlFor` ignore its argument and always return the newest URL of any project. Confirm the cross-project test fails and quote it. Restore and re-verify. That test is the one thing standing between this feature and opening another project's server.

- [ ] **Step 5: Commit**

```bash
git add src/main/devserver/registry.ts tests/unit/devServerRegistry.test.ts
git commit -m "Remember the newest dev server URL per project"
```

---

### Task 3: Wiring the registry into main

**Files:**
- Modify: `src/main/ipc/register.ts` (the `manager.onData` forward at line 870, and a new handler)
- Modify: `src/shared/ipc.ts` (one channel and its `PTermApi` method)
- Modify: `src/preload/index.ts` (expose it)
- Create: `tests/integration/devServerWiring.test.ts`

**Interfaces:**
- Consumes: Task 2's `DevServerRegistry`.
- Produces: `window.pterm.devServerUrl(projectSlug: string): Promise<string | null>`

- [ ] **Step 1: Write the failing integration test**

Drive `registerIpc` the way `tests/integration/openBrowser.test.ts` and its siblings already do, feed a pty chunk through the same path main uses, and assert `devServerUrl` answers with the URL. Then kill the pane and assert it answers null.

Read one of those existing integration files first and follow its setup rather than inventing a second harness.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/integration/devServerWiring.test.ts`

- [ ] **Step 3: Implement, then run**

The pane's project slug is on its config row. **The button calls `openBrowser` with a project id, and panes carry a project slug**: resolve one to the other in exactly one place and say where in a comment, because a mismatch here looks right and never matches.

Hook the observation into the existing forward at `register.ts:870` rather than adding a second `manager.onData` listener, so there is one place where a chunk is handled.

Clear a pane's entry where the app already learns a pane is gone. Find that place rather than adding a new lifecycle: `releaseAgentSession`'s call sites are a working example of the pattern, though this feature's clearing rule is its own.

- [ ] **Step 4: Full unit run and typecheck**

Run: `npm test`, then `npm run typecheck`. Both must be clean before the commit.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/register.ts src/shared/ipc.ts src/preload/index.ts tests/integration/devServerWiring.test.ts
git commit -m "Record dev server URLs as pty output arrives"
```

---

### Task 4: The button

**Files:**
- Modify: `src/renderer/TabBar.tsx`
- Modify: `src/renderer/App.tsx` (the terminal column's `TabBar`, and `openBrowserPane` at line 798)
- Modify: `tests/e2e/browserButton.spec.ts` (create it)

**Interfaces:**
- Consumes: Task 3's `window.pterm.devServerUrl`, and the existing `window.pterm.openBrowser(projectId, url?)`.
- Produces: nothing later tasks depend on.

`TabBar` gains one optional prop:

```ts
/** Renders the browser button when given. The browser column does not pass it. */
onOpenBrowser?: () => void
```

- [ ] **Step 1: Write the failing e2e test**

Cover: the button is present in the terminal tab bar; it is ABSENT from the browser column's bar; pressing it opens a browser pane; and pressing it after a pane announced a URL opens a pane showing that URL.

For the last one, drive a real announcement by echoing a Vite-shaped line into a terminal pane, the way the app would see it. Assert the pane's URL through main, not by reaching into the webview: Playwright cannot enter a `<webview>` on this codebase, `frames()` reports `about:blank` and `frameLocator` throws.

Give the button a testid that does NOT start with `tab-`.

- [ ] **Step 2: Run and watch it fail**

Run: `tmux -L pterm-test kill-server 2>/dev/null || true` then `npx playwright test tests/e2e/browserButton.spec.ts`

- [ ] **Step 3: Implement, then run**

The handler asks `devServerUrl` for the active project's slug, then calls `openBrowser(project.id, url ?? undefined)`. Always a new pane. With no active project it returns early, as `openBrowserPane` already does.

- [ ] **Step 4: Prove the absence test can fail**

Pass `onOpenBrowser` to the browser column's `TabBar` too, confirm the absence test fails, quote it, then restore. An absence assertion nobody has seen fail is not evidence.

- [ ] **Step 5: The pixel budget**

Run: `npx playwright test tests/e2e/splits.spec.ts`

That spec encodes the chrome width, and a previous column addition broke five of its tests on leftover terminal width alone. If it fails, the button is too wide and the fix is the button, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/TabBar.tsx src/renderer/App.tsx tests/e2e/browserButton.spec.ts
git commit -m "Open the project's dev server from the terminal tab bar"
```

---

### Task 5: The gate, and using it by hand

**Files:** none necessarily. This task is verification.

- [ ] **Step 1: The full gate**

Three separate commands, each in its own turn:

```bash
npm test
npm run typecheck
tmux -L pterm-test kill-server 2>/dev/null || true && npm run e2e
```

Attribute every failure. `tests/e2e/verticalTabs.spec.ts:144` fails in a load-dependent way from a text wrap, on this branch and on master alike; do not quote a flake rate for it. A failure you cannot attribute is a finding, not noise.

- [ ] **Step 2: Use it**

Open the real app, start a dev server in a project (`npm run dev` in anything Vite-shaped), and press the button. Write down what you saw: whether it opened on the right port, what happened on a second press, and what a project with no server did.

On the previous milestone three defects passed every automated gate and were found only this way. This step is not optional.

- [ ] **Step 3: Report**

Record the hand-run observations, including anything that surprised you.

---

## Self-Review

**Spec coverage:** the button to Task 4; watching output to Tasks 1 and 3; most-recent-wins and per-project filing to Task 2; always-a-new-pane and the blank fallback to Task 4; runtime-only lifetime to Task 2; the `tab-` testid hazard to Task 4 Step 1; the pixel budget to Task 4 Step 5; the hand-run to Task 5.

**Placeholders:** none. Task 2 and Task 3 describe their tests in prose rather than code, deliberately: their setup must follow an existing integration harness the implementer is told to read first, and pasting a fabricated harness here would be worse than pointing at the real one.

**Type consistency:** `scanForLocalUrl`, `SCAN_TAIL_BYTES`, `DevServerRegistry`, `observe`, `urlFor`, `forget`, and `devServerUrl` are spelled identically in every task that names them. The id-versus-slug hazard is called out in the facts section and again in Task 3.

**Known gap, stated rather than hidden:** a server started before pTerm opened, or one whose banner scrolled by in a pane the app was not yet watching, is invisible to this feature. The spec names port scanning as the way to close that and cuts it deliberately. If the hand-run in Task 5 shows this is the common case rather than the rare one, that is the finding that reopens the decision.
