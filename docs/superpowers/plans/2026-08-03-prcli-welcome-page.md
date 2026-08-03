# Welcome Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-line empty state in the pane area with a welcome page — wordmark, purpose line, three shortcut hints, and a state-dependent last line — shown whenever no pane group is visible.

**Architecture:** A pure selector `welcomeHint(state)` in `src/renderer/workspace.ts` decides the last line's text from `WorkspaceState`, so it is unit-testable with no DOM. A new presentational component `src/renderer/Welcome.tsx` renders the markup and takes that string as its only prop. `App.tsx` hoists its existing `paneGroups(state)` call to a const and renders `<Welcome>` when no group is visible.

**Tech Stack:** React 19, TypeScript, Tailwind v4 (theme colours in `src/renderer/index.css`), Vitest (node environment, `tests/unit/`), Playwright + Electron (`tests/e2e/`).

## Global Constraints

- **Spec of record:** `docs/superpowers/specs/2026-08-03-prcli-welcome-page-design.md`.
- **No em dashes** in code, comments or commit messages. Use commas, colons, parentheses or separate sentences.
- **The wordmark is `pTerm`, welcome-page copy only.** Do NOT touch `package.json`'s `name` or `productName`, `index.html`'s `<title>`, or `forge.config.ts`. The window title stays `PRCLI`.
- **Nothing on the welcome page is clickable.** No `<button>`, no `onClick`, no `href`.
- **Copy is exact.** Reproduce these strings character for character:
  - `pTerm`
  - `Manage Claude Code sessions across clients and departments.`
  - `Cmd+T` / `new session`, `Cmd+D` / `split right`, `Cmd+Shift+D` / `split down` (spelled `Cmd`, not `⌘`)
  - `select a working directory to start`
  - `press Cmd+T to start a session`
  - `select a project to start`
  - `` `${project.cwd} is missing` ``
- **Colours come from the Tailwind theme only:** `text-fg`, `text-muted`, `text-faint`, `bg-surface`, `border-border`. No hex literals, no `text-gray-*`.
- **This codebase comments the why, not the what.** Every non-obvious choice gets a comment explaining the reason it is that way and not the obvious alternative. Match the density of the file you are editing.
- **Verification commands:** `npm test` (vitest), `npm run typecheck` (tsc --noEmit), `npx playwright test tests/e2e/projects.spec.ts` (e2e, this file only).
- **Vitest runs in the `node` environment** (`vitest.config.mts`). There is no jsdom and no React testing library in this repo. Do NOT add one. React components are covered by e2e only.

---

## File Structure

| file | responsibility |
|---|---|
| `src/renderer/workspace.ts` | add `welcomeHint(state)` — the only place the hint's four cases are decided |
| `src/renderer/Welcome.tsx` | new — markup and styling for the welcome page, no state, no IPC, one prop |
| `src/renderer/App.tsx` | hoist `paneGroups(state)`, derive `showWelcome`, swap the empty-state `<p>` for `<Welcome>` |
| `tests/unit/workspace.test.ts` | `welcomeHint`'s four cases plus the ordering case |
| `tests/e2e/projects.spec.ts` | testid rename at line 163, plus the open/close round trip |

---

### Task 1: The `welcomeHint` selector

**Files:**
- Modify: `src/renderer/workspace.ts` (add an export; `UNSORTED_ID` and `activeProject` are already in scope, see line 2 and line 128)
- Test: `tests/unit/workspace.test.ts`

**Interfaces:**
- Consumes: `WorkspaceState` (exported from `src/renderer/workspace.ts:10`), `activeProject(state)` (`workspace.ts:128`), `UNSORTED_ID` (imported at `workspace.ts:2` from `../shared/ipc`).
- Produces: `export function welcomeHint(state: WorkspaceState): string` — used by Task 3.

Relevant shapes, so you do not have to go looking:

```ts
interface WorkspaceState {
  projects: ProjectDescriptor[]
  panes: TabDescriptor[]
  tabs: TabRow[]
  activeProjectId: string | null
  status: Record<string, TabState>
  dead: Record<string, number>
}

interface ProjectDescriptor {
  id: string
  name: string
  slug: string
  cwd: string
  presets: ResolvedPreset[]
  activeTabId: string | null
  /** False when `cwd` is no longer a directory — renamed or deleted. */
  available: boolean
}
```

`tests/unit/workspace.test.ts` already defines a `project(id, slug, activeTabId?)` helper at line 40 that returns a `ProjectDescriptor` with `cwd: '/tmp'` and `available: true`. Reuse it and spread over it where a case needs a different `cwd` or `available`.

- [ ] **Step 1: Write the failing tests**

Add `welcomeHint` to the existing import block at the top of `tests/unit/workspace.test.ts` (it imports from `'../../src/renderer/workspace'`, keep the list alphabetical-ish as it already is), and append this `describe` block to the end of the file:

```ts
describe('welcomeHint', () => {
  // The zero-projects case is checked before the pick-a-project case, and this
  // state is why: with no projects there is also no active project, so both
  // branches match and only the order decides which sentence a first launch
  // gets. The useless one would be "select a project to start".
  it('asks for a working directory when there are no projects', () => {
    expect(welcomeHint(INITIAL_WORKSPACE_STATE)).toBe('select a working directory to start')
  })

  it('names the keystroke when a launchable project is active', () => {
    const state: WorkspaceState = {
      ...INITIAL_WORKSPACE_STATE,
      projects: [project('id-alpha', 'alpha')],
      activeProjectId: 'id-alpha',
    }
    expect(welcomeHint(state)).toBe('press Cmd+T to start a session')
  })

  it('asks for a project when one exists but none is active', () => {
    const state: WorkspaceState = {
      ...INITIAL_WORKSPACE_STATE,
      projects: [project('id-alpha', 'alpha')],
      activeProjectId: null,
    }
    expect(welcomeHint(state)).toBe('select a project to start')
  })

  // Unsorted is not a directory and cannot launch anything, so the only move
  // from it is to pick a real project: it shares the line above rather than
  // getting one of its own.
  it('asks for a project when Unsorted is active', () => {
    const state: WorkspaceState = {
      ...INITIAL_WORKSPACE_STATE,
      projects: [project('id-alpha', 'alpha'), project(UNSORTED_ID, 'unsorted')],
      activeProjectId: UNSORTED_ID,
    }
    expect(welcomeHint(state)).toBe('select a project to start')
  })

  // Same wording as the sidebar's `!` marker (`Sidebar.tsx:130`). Two
  // sentences for one condition would read as two conditions.
  it('names the missing directory when the active project cwd is gone', () => {
    const state: WorkspaceState = {
      ...INITIAL_WORKSPACE_STATE,
      projects: [{ ...project('id-alpha', 'alpha'), cwd: '/tmp/gone', available: false }],
      activeProjectId: 'id-alpha',
    }
    expect(welcomeHint(state)).toBe('/tmp/gone is missing')
  })
})
```

`describe`, `it`, `expect`, `INITIAL_WORKSPACE_STATE`, `UNSORTED_ID`, `WorkspaceState` and the `project` helper are all already imported or defined in that file. Only `welcomeHint` is new to the import list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/workspace.test.ts`

Expected: the file fails to collect, with a message naming `welcomeHint` as not exported by `src/renderer/workspace.ts`.

- [ ] **Step 3: Implement the selector**

Append to `src/renderer/workspace.ts`:

```ts
/**
 * What the welcome page's last line says.
 *
 * The sentence form of `canOpen` in `App.tsx`
 * (`Boolean(project) && project?.id !== UNSORTED_ID && project?.available === true`),
 * naming whichever of the three parts is missing. One predicate, two
 * renderings: a hint that disagreed with whether ⌘T works would be worse than
 * no hint.
 *
 * Here rather than in `Welcome.tsx` so it can be exercised against a
 * `WorkspaceState` with no DOM, which is how every other derivation in this
 * file is tested.
 */
export function welcomeHint(state: WorkspaceState): string {
  // Before the no-active-project case below, which would otherwise claim a
  // first launch too: with no projects there is no active project either.
  if (state.projects.length === 0) return 'select a working directory to start'
  const project = activeProject(state)
  // Unsorted shares this line because it is not a directory and cannot launch;
  // the move out of it is the same move, pick a real project.
  if (!project || project.id === UNSORTED_ID) return 'select a project to start'
  if (!project.available) return `${project.cwd} is missing`
  return 'press Cmd+T to start a session'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/workspace.test.ts`
Expected: PASS, five new tests green, every pre-existing test in the file still green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/workspace.ts tests/unit/workspace.test.ts
git commit -m "Derive the welcome hint from the same predicate as canOpen

The welcome page's last line has to say what is missing: no projects, no
project selected, or a project whose directory is gone. That is canOpen's
three-part test read out loud, so it is written once, beside the other
state selectors, where it can be tested without a DOM."
```

---

### Task 2: The `Welcome` component

**Files:**
- Create: `src/renderer/Welcome.tsx`
- Test: none. Vitest runs in the `node` environment (`vitest.config.mts`) with no jsdom and no React testing library; this component is covered by the e2e in Task 4. Do NOT add a DOM test runner to this repo.

**Interfaces:**
- Consumes: nothing. No imports from `workspace.ts`, no IPC, no state.
- Produces: `export function Welcome({ hint }: { hint: string })` — rendered by Task 3. Renders `data-testid="welcome"` on its root and `data-testid="welcome-hint"` on its last line.

- [ ] **Step 1: Write the component**

Create `src/renderer/Welcome.tsx`:

```tsx
/**
 * The three shortcuts that put a pane on screen, which is what someone looking
 * at no panes needs.
 *
 * ⌘W, ⌘⌥arrow, ⌘⇧\ and ⌘, are all real bindings and all absent here: none of
 * them does anything when nothing is running.
 */
const SHORTCUTS = [
  { glyph: '+', keys: 'Cmd+T', label: 'new session' },
  { glyph: '▯', keys: 'Cmd+D', label: 'split right' },
  { glyph: '⊟', keys: 'Cmd+Shift+D', label: 'split down' },
]

/**
 * What the pane area shows when it has nothing to show: the name, what the app
 * is for, the shortcuts that create a pane, and one line saying what to do
 * from here.
 *
 * Nothing on it is clickable, deliberately. The row's job is to teach three
 * keystrokes, and a row of buttons would teach the mouse instead. Every action
 * named here is already a click away in the sidebar and in the tab bar's `+`,
 * both of which stay on screen around this.
 *
 * Purely presentational. `hint` is chosen by `welcomeHint` in workspace.ts,
 * where the four cases can be tested without a DOM.
 *
 * `absolute inset-0` to match the pane groups it sits among, so it centres
 * against the same box they fill. It only renders when none of them is
 * visible, so no z-index is needed to settle who paints on top: an invisible
 * group paints nothing and its `pointer-events-none` means it catches nothing
 * either.
 */
export function Welcome({ hint }: { hint: string }) {
  return (
    <div
      data-testid="welcome"
      className="absolute inset-0 flex select-none flex-col items-center justify-center gap-3"
    >
      <h1 className="m-0 font-mono text-[15px] font-semibold tracking-tight text-fg">pTerm</h1>
      <p className="m-0 text-[13px] text-muted">
        Manage Claude Code sessions across clients and departments.
      </p>

      <div className="mt-4 flex items-center font-mono text-[11px]">
        {SHORTCUTS.map((shortcut, index) => (
          <div key={shortcut.keys} className="flex items-center">
            {/* Between items only. A divider after the last one would read as
                a fourth item that failed to render. */}
            {index > 0 ? <span className="mx-3 text-faint">|</span> : null}
            <span className="mr-1.5 text-faint">{shortcut.glyph}</span>
            {/* Spelled `Cmd+T`, not `⌘T`: this is being read as an instruction
                rather than recognised on a menu. */}
            <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 text-muted">
              {shortcut.keys}
            </kbd>
            <span className="ml-1.5 text-faint">{shortcut.label}</span>
          </div>
        ))}
      </div>

      <p data-testid="welcome-hint" className="m-0 mt-2 font-mono text-[11px] text-faint">
        <span className="mr-1.5">&gt;_</span>
        {hint}
      </p>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0. (The component is unused at this point; `tsc --noEmit` does not object to an unused export.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/Welcome.tsx
git commit -m "Add the welcome page's markup

Wordmark, one line of purpose, the three shortcuts that create a pane,
and a hint line. Static text throughout: the row exists to teach
keystrokes, and buttons would teach the mouse instead."
```

---

### Task 3: Render it from `App.tsx`

**Files:**
- Modify: `src/renderer/App.tsx` (import block at lines 1-30, the derived consts near line 67-72, and the pane container at lines 679-690)
- Test: `tests/e2e/projects.spec.ts:163` (the assertion this change renames out from under)

**Interfaces:**
- Consumes: `welcomeHint` from Task 1, `Welcome` from Task 2, and `paneGroups` (already imported at `App.tsx:17`).
- Produces: `data-testid="welcome"` in the rendered DOM, replacing `data-testid="empty-state"`, which no longer exists anywhere after this task.

- [ ] **Step 1: Add the imports**

In `src/renderer/App.tsx`, add to the component imports near line 9:

```tsx
import { Welcome } from './Welcome'
```

and add `welcomeHint` to the existing `from './workspace'` import block (lines 11-28), after `tabsOfProject` and before `workspaceReducer`.

- [ ] **Step 2: Hoist `paneGroups` and derive the condition**

Find these lines near `App.tsx:69`:

```tsx
  const currentTabs = state.activeProjectId ? tabsOfProject(state, state.activeProjectId) : []
```

Immediately after that line, add:

```tsx
  // Hoisted out of the JSX below because the welcome page's condition is read
  // off it. "No visible group" is the literal statement of an empty pane area,
  // and it is not the same as "no tabs": a tab whose kids were all boxed by an
  // earlier row emits no group at all (`workspace.ts:667`).
  const groups = paneGroups(state)
  const showWelcome = !groups.some((group) => group.visible)
```

- [ ] **Step 3: Swap the empty state for the welcome page**

In the pane container near `App.tsx:679`, replace:

```tsx
          {state.projects.length === 0 ? (
            <p data-testid="empty-state" className="p-4 font-mono text-[12px] text-muted">
              No projects yet. Add one to open a terminal.
            </p>
          ) : null}
```

with:

```tsx
          {showWelcome ? <Welcome hint={welcomeHint(state)} /> : null}
```

- [ ] **Step 4: Use the hoisted const**

A few lines below, change:

```tsx
          {paneGroups(state).map((group) => (
```

to:

```tsx
          {groups.map((group) => (
```

- [ ] **Step 5: Point the existing e2e assertion at the new testid**

At `tests/e2e/projects.spec.ts:163`, change:

```ts
  await expect(window.getByTestId('empty-state')).toBeVisible()
```

to:

```ts
  await expect(window.getByTestId('welcome')).toBeVisible()
  await expect(window.getByTestId('welcome-hint')).toContainText(
    'select a working directory to start',
  )
```

Same assertion about the same moment, a fresh launch with no projects, so it keeps its place in `starts with no projects and opens no session`. The second line pins which of the four hints a launch with nothing on disk gets.

- [ ] **Step 6: Verify no `empty-state` reference survives**

Run: `grep -rn "empty-state" src tests`
Expected: exactly one hit, a prose comment at `tests/unit/workspace.test.ts:870-872`. It names a testid that no longer exists, and its reasoning is now half wrong: the welcome page does appear in the state it describes. Replace those three lines:

```ts
  // Filing the last stray empties Unsorted, so the reply omits it — and the
  // selection pointing at it would leave a blank pane, an empty tab bar and no
  // empty-state to explain it.
```

with:

```ts
  // Filing the last stray empties Unsorted, so the reply omits it, and the
  // selection pointing at it would leave a blank pane, an empty tab bar and no
  // project highlighted in the sidebar. The welcome page would come up over
  // that and say "select a project to start", which is true and useless: there
  // is one project and the user has just filed a session into it.
```

Note the em dash in the original first line is gone: the no-em-dash constraint binds every line you write, including one you are only partly rewriting.

- [ ] **Step 7: Typecheck and run the unit suite**

Run: `npm run typecheck && npm test`
Expected: typecheck silent, exit 0. Vitest green, no regressions.

- [ ] **Step 8: Run the e2e file**

Run: `npx playwright test tests/e2e/projects.spec.ts`
Expected: 10 passed.

If a run dies before the window appears, that is the known pre-existing macOS launch flake documented in this spec's own header comment, not this change. Re-run once before investigating.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/App.tsx tests/e2e/projects.spec.ts tests/unit/workspace.test.ts
git commit -m "Show the welcome page whenever the pane area is empty

The sentence it replaces appeared under one condition, zero projects, so
a user who had projects and had closed their last session got a blank
rectangle. The condition is now no visible pane group, which is the
literal statement of the thing being replaced and also covers a selected
project with no tabs."
```

---

### Task 4: The round trip

**Files:**
- Modify: `tests/e2e/projects.spec.ts` (append a test; update the header comment's test count at line 5)

**Interfaces:**
- Consumes: `data-testid="welcome"` and `data-testid="welcome-hint"` from Tasks 2 and 3; the file's existing `candidate()`, `seed()` and `launch()` helpers.
- Produces: nothing other tasks depend on.

This is the behaviour the design adds over the sentence it replaces, and no unit test can see it: it is `showWelcome` reading `paneGroups`' output through a real render.

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/e2e/projects.spec.ts`:

```ts
test('the welcome page goes when a session opens and returns when it closes', async () => {
  const alpha = await candidate('alpha')
  await seed(
    [{ id: 'id-alpha', name: 'Alpha', slug: 'alpha', cwd: alpha, presets: [], activeTabId: null }],
    'id-alpha',
  )
  const app = await launch()
  const window = await app.firstWindow()

  // A project is selected and nothing is running in it. This is the state the
  // sentence this page replaced could not describe: it only appeared when
  // there were no projects at all, so this launch used to show a blank box.
  await expect(window.getByTestId('welcome')).toBeVisible()
  await expect(window.getByTestId('welcome-hint')).toContainText('press Cmd+T to start a session')

  await window.getByTestId('new-tab').click()
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)
  await expect(window.getByTestId('welcome')).toBeHidden()

  // ⌘W with the terminal focused, the same way `a shortcut typed into the
  // rename field does not reach the tab handler` closes its last tab.
  await window.getByTestId('terminal-active').click()
  await window.keyboard.press('Meta+w')
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(0)
  await expect(window.getByTestId('welcome')).toBeVisible()

  await app.close()
})
```

`toBeHidden()` passes for an element that is not in the DOM at all, which is what `showWelcome` produces: the component is not rendered rather than hidden.

- [ ] **Step 2: Run it and watch it pass, then prove it can fail**

Run: `npx playwright test tests/e2e/projects.spec.ts -g "welcome page goes"`
Expected: 1 passed.

A test that cannot fail is worth nothing, so measure it before believing it. Temporarily change `showWelcome` in `App.tsx` to the constant `false`:

```tsx
  const showWelcome = false
```

Run: `npx playwright test tests/e2e/projects.spec.ts -g "welcome page goes"`
Expected: FAIL at the first `toBeVisible()`.

Now change it to the constant `true` instead:

```tsx
  const showWelcome = true
```

Run: `npx playwright test tests/e2e/projects.spec.ts -g "welcome page goes"`
Expected: FAIL at `toBeHidden()`.

Restore the real line:

```tsx
  const showWelcome = !groups.some((group) => group.visible)
```

Both halves of the round trip bite. Record the two results in the comment you write in Step 3.

- [ ] **Step 3: Update the file's header comment**

`tests/e2e/projects.spec.ts` opens with a comment that counts and summarises every test in the file. At line 5 it reads `Ten tests on the ...`. Change that to `Eleven tests on the ...`, and append a clause to the end of that same sentence's list, which currently ends `and removing a project leaves its session alive under Unsorted.`:

```
; and the welcome page is up when a selected project has no session and
returns when its last pane closes.
```

Then add a measured note in the style of the ones already in that header, using the two results from Step 2 and the date you actually ran them (the plan was written 2026-08-03):

```
 * **Measured, 2026-08-03, this file run alone**: pinning `showWelcome`
 * in `App.tsx` to `false` fails `the welcome page goes when a session opens
 * and returns when it closes` at its first assertion; pinning it to `true`
 * fails the same test at its `toBeHidden()`. Both directions of the round
 * trip are held by that one test.
```

- [ ] **Step 4: Run the whole file**

Run: `npx playwright test tests/e2e/projects.spec.ts`
Expected: 11 passed.

- [ ] **Step 5: Full verification**

Run: `npm run typecheck && npm test && npm run check-deps`
Expected: typecheck silent; vitest green; check-deps clean.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/projects.spec.ts
git commit -m "Pin both directions of the welcome page's round trip

Opening a session must take it away and closing the last pane must bring
it back. Measured: pinning showWelcome to false fails the first
assertion, pinning it to true fails the toBeHidden, so neither half is
along for the ride."
```
