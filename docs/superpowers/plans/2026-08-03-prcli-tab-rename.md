# Tab Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tab be given a name, shown in both the tab bar and the sidebar, surviving relaunch, with a blank name clearing it.

**Architecture:** The name is one optional `title` field on the pane, stored in config (version 5 to 6) and carried on `TabDescriptor`. A pure selector `labelOfPane` decides what any surface displays, replacing three separate copies of the current label template. Editing goes through one `renameTab` IPC call that resolves to the whole pane list, reached from two triggers that share one input.

**Tech Stack:** Electron 43, React 19, TypeScript, Tailwind v4, Vitest (node environment, `tests/unit/`), Playwright + Electron (`tests/e2e/`).

## Global Constraints

- **Spec of record:** `docs/superpowers/specs/2026-08-03-prcli-tab-rename-design.md`.
- **No em dashes** on any line you write: code, comments, commit messages. Commas, colons, parentheses or separate sentences instead. Pre-existing em dashes on untouched lines stay.
- **`TabDescriptor` is a pane, `TabRow` is a tab.** The names are historical. Everything in this plan attaches to the pane.
- **The default label is exactly** `` `${pane.projectSlug} · ${pane.id.slice(0, 6)}` ``, with a U+00B7 MIDDLE DOT surrounded by single spaces. Copy it, do not retype it.
- **A blank name clears the title**, reverting to the default. This deliberately differs from renaming a project, where blank is ignored.
- **Titles are display text and never touch tmux.** A pane's tmux session name stays `prcli-${slug}-${id}`, which is what restore matches saved rows by. Do not pass a title into `SessionManager`, `OpenInput`, or anything under `src/main/sessions/`.
- **This codebase comments the why, not the what.** Match the density of the file you are editing; these files are heavily commented on purpose.
- **Claims must not outrun their evidence.** If you write that something is measured, measure it and report the numbers. If it is inferred, say inferred.
- **Vitest runs in the `node` environment** (`vitest.config.mts`): no jsdom, no React testing library, and none may be added. React components are covered by e2e only.
- **Verification:** `npm run typecheck`, `npm test`, `npx playwright test tests/e2e/tabs.spec.ts`.
- **Baseline before Task 1:** typecheck silent, `npm test` 41 files / 1158 tests, `npx playwright test` 45 passed.

---

## File Structure

| file | responsibility |
|---|---|
| `src/main/sessions/manager.ts` | `PaneRecord` gains `title?: string`. Nothing else here changes; the manager never reads it. |
| `src/main/state/store.ts` | config version 5 to 6; `isPane`/`normalisePane` accept and sanitise `title`; migration |
| `src/main/ipc/titles.ts` | new, tiny: `attachTitles`, the one place a saved title is put back onto a live descriptor |
| `src/main/ipc/restore.ts` | calls `attachTitles` before returning panes |
| `src/main/ipc/register.ts` | `renameTab` handler; `moveTabToProject` calls `attachTitles` too |
| `src/shared/ipc.ts` | `title?: string` on `TabDescriptor`; `CHANNELS.renameTab`; `PrcliApi.renameTab` |
| `src/preload/index.ts` | `renameTab` bridge |
| `src/renderer/workspace.ts` | new `labelOfPane`; new `renamedTab` reducer action |
| `src/renderer/TabBar.tsx` | rename input, context menu, uses `labelOfPane` |
| `src/renderer/Sidebar.tsx` | uses `labelOfPane` for its tab rows |
| `src/renderer/DeadPane.tsx` | uses `labelOfPane` for its two aria-labels |
| `src/renderer/App.tsx` | `renameTab` handler wired to `TabBar` |

---

### Task 1: Persist a title

**Files:**
- Modify: `src/main/sessions/manager.ts` (the `PaneRecord` interface at line 13)
- Modify: `src/main/state/store.ts` (`PrcliConfig.version`, `EMPTY`, `isPane`, `normalisePane`, `migrate`)
- Test: `tests/unit/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PaneRecord` with `title?: string`; `PrcliConfig` with `version: 6`. Task 3 reads `title` off these records.

Shapes you need, so you do not have to go looking:

```ts
// src/main/sessions/manager.ts:13
export interface PaneRecord {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
  type: TabType
}
```

`store.ts` already has `isPane` (a type guard over untrusted JSON) and `normalisePane` (which back-fills `type` for old rows). `migrate` has a `value.version === 5` branch and an `[1, 2, 3, 4]` branch, and returns `{ ...EMPTY }` for anything newer.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/store.test.ts`, inside the existing top-level `describe`:

```ts
it('carries a pane title through a v6 read', async () => {
  const store = await storeWith({
    version: 6,
    projects: [],
    activeProjectId: null,
    panes: [
      {
        id: 'a'.repeat(16),
        projectSlug: 'lumio',
        cwd: '/tmp',
        tmuxSession: 'prcli-lumio-' + 'a'.repeat(16),
        type: 'shell',
        title: 'payments api',
      },
    ],
    tabs: [],
  })
  const config = await store.read()
  expect(config.version).toBe(6)
  expect(config.panes[0].title).toBe('payments api')
})

// A title is display text read straight back out to the screen, and config is
// a file a user can edit. Everything else in this store sanitises what it
// reads; a title is not the one field to trust.
it('drops a title that is not a string', async () => {
  const store = await storeWith({
    version: 6,
    projects: [],
    activeProjectId: null,
    panes: [
      {
        id: 'a'.repeat(16),
        projectSlug: 'lumio',
        cwd: '/tmp',
        tmuxSession: 'prcli-lumio-' + 'a'.repeat(16),
        type: 'shell',
        title: { evil: true },
      },
    ],
    tabs: [],
  })
  const config = await store.read()
  expect(config.panes).toHaveLength(1)
  expect(config.panes[0].title).toBeUndefined()
})

// v5 is the shape this feature was added to. A row from it was never named,
// which is exactly what an absent title already means, so the migration has
// nothing to invent.
it('migrates a v5 config to v6, leaving panes unnamed', async () => {
  const store = await storeWith({
    version: 5,
    projects: [],
    activeProjectId: null,
    panes: [
      {
        id: 'a'.repeat(16),
        projectSlug: 'lumio',
        cwd: '/tmp',
        tmuxSession: 'prcli-lumio-' + 'a'.repeat(16),
        type: 'shell',
      },
    ],
    tabs: [],
  })
  const config = await store.read()
  expect(config.version).toBe(6)
  expect(config.panes).toHaveLength(1)
  expect(config.panes[0].id).toBe('a'.repeat(16))
  expect(config.panes[0].title).toBeUndefined()
})
```

`storeWith`, `describe`, `it` and `expect` are already defined or imported in that file.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/store.test.ts`
Expected: FAIL. The two v6 tests fail because `migrate` treats 6 as a version from the future and returns `EMPTY`, so `config.panes` is `[]`. The v5 test fails on `expect(config.version).toBe(6)`, receiving 5.

- [ ] **Step 3: Add the field**

In `src/main/sessions/manager.ts`, add to `PaneRecord`:

```ts
  /**
   * What the user called this pane, absent until they name one.
   *
   * Display text only. It is on this record because config is where it is
   * persisted, and nothing in this file reads it: a pane's tmux session is
   * named `prcli-${slug}-${id}` and restore matches saved rows against live
   * sessions by that name, so a title has no more to do with tmux than a
   * window's colour does.
   */
  title?: string
```

- [ ] **Step 4: Take the store to v6**

In `src/main/state/store.ts`:

Change `PrcliConfig`'s `version: 5` to `version: 6`, and `EMPTY`'s `version: 5` to `version: 6`.

Add title handling to `normalisePane`. It currently returns early when `type` is already valid, so the title check has to come first:

```ts
function normalisePane(pane: PaneRecord): PaneRecord {
  // Before the `type` shortcut below, which returns early: a row can have a
  // good type and a bad title at the same time.
  const titled = typeof pane.title === 'string' ? pane : { ...pane, title: undefined }
  if (TAB_TYPES.includes(titled.type)) return titled
  // A v3 row cannot say whether it was running Claude, and does not need to —
  // hooks decide that. Only the launch command is knowable from the record.
  return { ...titled, type: titled.command === undefined ? 'shell' : 'preset' }
}
```

In `migrate`, change the v5 branch to accept both 5 and 6, since a v5 config and a v6 config differ only by a field whose absence is meaningful:

```ts
  // 5 and 6 share a shape. v6 added an optional pane title, and a v5 row not
  // having one is exactly what "never named" already means, so there is
  // nothing to convert and one branch reads both.
  if (value.version === 5 || value.version === 6) {
    const panes = paneRows(candidate.panes)
    return {
      version: 6,
      projects,
      activeProjectId,
      panes,
      tabs: tabRows(candidate.tabs, panes),
      notifications: normaliseNotifications(candidate.notifications),
    }
  }
```

And in the `[1, 2, 3, 4]` branch, change its `version: 5` to `version: 6`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/store.test.ts`
Expected: PASS, including every pre-existing test in the file. Several of them assert on `version`; if any still expects 5, it is asserting the old contract and should be updated to 6 as part of this task.

- [ ] **Step 6: Full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck silent; vitest green.

- [ ] **Step 7: Commit**

```bash
git add src/main/sessions/manager.ts src/main/state/store.ts tests/unit/store.test.ts
git commit -m "Give a pane somewhere to keep a name

Config goes to v6 for one optional title field. The bump is what makes
the store's existing refusal to overwrite a newer file fire: without it
an older build would read the file, not know about title, and drop every
name on its next write with nothing said.

v5 and v6 share a shape, so one branch reads both. A v5 row has no title,
which is already what never named means."
```

---

### Task 2: One label rule, three callers

**Files:**
- Modify: `src/shared/ipc.ts` (`TabDescriptor`)
- Modify: `src/renderer/workspace.ts` (new export)
- Modify: `src/renderer/TabBar.tsx:5-8` (delete local `label`)
- Modify: `src/renderer/DeadPane.tsx:4-7` (delete local `label`)
- Modify: `src/renderer/Sidebar.tsx:209` (inline copy)
- Test: `tests/unit/workspace.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1. This task is renderer-side and `title` is never set yet, so every label still renders exactly as before.
- Produces: `export function labelOfPane(pane: TabDescriptor): string`, used by Task 4; `TabDescriptor.title`, set by Task 3.

There are three definitions of the same template today: `TabBar.tsx:7`, `DeadPane.tsx:6`, and an inline JSX copy at `Sidebar.tsx:209`. `TabBar` calls its local `label` four times (the visible span plus three aria-labels) and `DeadPane` calls its own twice.

- [ ] **Step 1: Write the failing tests**

Add `labelOfPane` to the existing import block at the top of `tests/unit/workspace.test.ts`, then append:

```ts
describe('labelOfPane', () => {
  it('falls back to the project slug and a slice of the id', () => {
    expect(labelOfPane(tab('a'.repeat(16), 'lumio'))).toBe('lumio · aaaaaa')
  })

  it('uses the title once there is one', () => {
    expect(labelOfPane({ ...tab('a'.repeat(16), 'lumio'), title: 'payments api' })).toBe(
      'payments api',
    )
  })

  // How a name is cleared: the renderer sends '' and the store drops the
  // field, but a config edited by hand can still hold one, and an empty tab
  // is unclickable and unreadable.
  it('falls back when the title is an empty string', () => {
    expect(labelOfPane({ ...tab('a'.repeat(16), 'lumio'), title: '' })).toBe('lumio · aaaaaa')
  })
})
```

The `tab(id, projectSlug)` helper is defined at the top of that file and returns a `TabDescriptor` with `projectSlug` defaulting to `'lumio'`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/workspace.test.ts`
Expected: the file fails to collect, naming `labelOfPane` as not exported by `src/renderer/workspace.ts`.

- [ ] **Step 3: Add the field and the selector**

In `src/shared/ipc.ts`, add to `TabDescriptor`:

```ts
  /** What the user called this tab. Absent until they name one. */
  title?: string
```

Append to `src/renderer/workspace.ts`:

```ts
/**
 * What any surface listing this pane should call it.
 *
 * One rule with three callers, which is the point: the tab bar, the sidebar
 * and the dead-pane overlay each built this string themselves before, so a
 * name that reached one of them would have reached only that one. The tab bar
 * and the sidebar are the two places the user sees, and the overlay's copies
 * are what a screen reader announces.
 *
 * An empty title falls back rather than rendering. Empty is how a name is
 * cleared, and the store drops the field when it sees one, but a config edited
 * by hand can still carry `title: ""`, and a tab with no label at all cannot
 * be read or aimed at.
 *
 * Here rather than in a component so it can be tested against a plain object
 * with no DOM, which is how every other derivation in this file is tested.
 */
export function labelOfPane(pane: TabDescriptor): string {
  return pane.title ? pane.title : `${pane.projectSlug} · ${pane.id.slice(0, 6)}`
}
```

- [ ] **Step 4: Point all three callers at it**

In `src/renderer/TabBar.tsx`, delete the local `label` function and its docstring (lines 5-8), import `labelOfPane` from `./workspace`, and replace all four `label(tab)` calls with `labelOfPane(tab)`.

In `src/renderer/DeadPane.tsx`, delete the local `label` function and its docstring (lines 4-7), import `labelOfPane` from `./workspace`, and replace both `label(pane)` calls with `labelOfPane(pane)`.

In `src/renderer/Sidebar.tsx`, import `labelOfPane` from `./workspace` and replace line 209's `{tab.projectSlug} · {tab.id.slice(0, 6)}` with `{labelOfPane(tab)}`.

- [ ] **Step 5: Verify nothing builds that label any more**

Run: `grep -rn "projectSlug} · \|projectSlug} · " src/renderer`
Expected: one hit only, inside `labelOfPane` in `workspace.ts`. Any other hit is a caller you missed.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/unit/workspace.test.ts && npm run typecheck`
Expected: PASS, typecheck silent.

- [ ] **Step 7: Prove the refactor is load-bearing**

This step changed what three files display without changing any behaviour, so measure that the surfaces really do go through the new function. Temporarily make `labelOfPane` return the literal string `'MUTATED'`, then run:

Run: `npx playwright test tests/e2e/tabs.spec.ts`
Expected: FAIL. Record which tests failed and how many.

Restore `labelOfPane`, re-run, and confirm the file is back to green. Report both numbers in your report. If the mutation leaves the e2e file green, the tab bar is not reading your selector and Step 4 is incomplete: stop and report that rather than continuing.

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc.ts src/renderer/workspace.ts src/renderer/TabBar.tsx src/renderer/DeadPane.tsx src/renderer/Sidebar.tsx tests/unit/workspace.test.ts
git commit -m "Write the tab label once instead of three times

The tab bar, the sidebar and the dead-pane overlay each built the same
slug-and-id string. A name added to one of them would have reached that
one only, and the sidebar is half of what this feature is for.

No display change: title is not set by anything yet, so every label
still resolves to the same string it did before."
```

---

### Task 3: The rename round trip

**Files:**
- Modify: `src/shared/ipc.ts` (`CHANNELS`, `PrcliApi`)
- Create: `src/main/ipc/titles.ts`
- Modify: `src/main/ipc/restore.ts` (attach titles to what it returns)
- Modify: `src/main/ipc/register.ts` (`renameTab` handler; `moveTabToProject` attaches titles)
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/workspace.ts` (`renamedTab` action)
- Modify: `src/renderer/App.tsx` (handler, passed to `TabBar`)
- Test: `tests/unit/workspace.test.ts`

**Interfaces:**
- Consumes: `PaneRecord.title` (Task 1), `TabDescriptor.title` and `labelOfPane` (Task 2).
- Produces: `window.prcli.renameTab(id, title): Promise<TabDescriptor[]>`; a `renameTab: (id: string, title: string) => void` prop that Task 4 calls from `TabBar`.

**Why a helper rather than threading the title through the session manager.** `restore.ts` builds each `TabDescriptor` by calling `manager.open({...})`, and the manager's business is tmux. A title has nothing to do with tmux, so it is put back on afterwards, in one place that every path returning descriptors calls.

- [ ] **Step 1: Write the failing reducer test**

Append to `tests/unit/workspace.test.ts`:

```ts
describe('renamedTab', () => {
  // Replacing the array wholesale is the same discipline `movedTab` follows:
  // main answers with the whole list, so a mutation and a relaunch cannot
  // disagree about what is on screen.
  it('replaces the pane list and leaves tabs and layout alone', () => {
    const before: WorkspaceState = {
      ...INITIAL_WORKSPACE_STATE,
      projects: [project('p1', 'lumio')],
      panes: [tab('aaa', 'lumio'), tab('bbb', 'lumio')],
      tabs: [tabRow('aaa', ['aaa']), tabRow('bbb', ['bbb'])],
      activeProjectId: 'p1',
    }
    const next = workspaceReducer(before, {
      type: 'renamedTab',
      panes: [{ ...tab('aaa', 'lumio'), title: 'payments api' }, tab('bbb', 'lumio')],
    })
    expect(next.panes.map((pane) => pane.title)).toEqual(['payments api', undefined])
    expect(next.tabs).toEqual(before.tabs)
    expect(next.activeProjectId).toBe('p1')
  })
})
```

`tabRow(id, kids)` and `project(id, slug)` are helpers already defined in that file.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/workspace.test.ts -t renamedTab`
Expected: FAIL, a TypeScript or runtime error that `'renamedTab'` is not one of the reducer's action types.

- [ ] **Step 3: Add the action**

In `src/renderer/workspace.ts`, add to the action union:

```ts
  | { type: 'renamedTab'; panes: TabDescriptor[] }
```

and to `workspaceReducer`:

```ts
    case 'renamedTab':
      // Only the panes: a name changes no tab's layout, order or selection,
      // and main's reply carries the whole list for the same reason
      // `movedTab`'s does.
      return { ...state, panes: action.panes }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/workspace.test.ts -t renamedTab`
Expected: PASS.

- [ ] **Step 5: Add the channel and the API**

In `src/shared/ipc.ts`, add to `CHANNELS`:

```ts
  renameTab: 'prcli:renameTab',
```

and to `PrcliApi`, beside `moveTabToProject`:

```ts
  /**
   * Name a tab, or clear its name with an empty string.
   *
   * Resolves to every pane, like every other mutation here: the renderer
   * replaces its list from one authoritative reply rather than patching one
   * entry and hoping the rest still agree.
   */
  renameTab(id: string, title: string): Promise<TabDescriptor[]>
```

- [ ] **Step 6: Add the helper**

Create `src/main/ipc/titles.ts`:

```ts
import type { TabDescriptor } from '../../shared/ipc'
import type { PaneRecord } from '../sessions/manager'

/**
 * Put saved titles back onto freshly built descriptors.
 *
 * Every path that answers with panes builds them from live tmux by way of
 * `SessionManager`, which knows nothing about titles and should not: a pane's
 * session is named `prcli-${slug}-${id}`, and that name is what restore
 * matches saved rows by. A title is display text stored beside it.
 *
 * So the title is reattached here instead, in the one function all three of
 * those paths call, rather than threaded through `OpenInput` and back out
 * again. A pane with no saved row, or a row with no title, is returned exactly
 * as it came in.
 */
export function attachTitles(panes: TabDescriptor[], records: PaneRecord[]): TabDescriptor[] {
  const titles = new Map(records.filter((row) => row.title).map((row) => [row.id, row.title]))
  return panes.map((pane) => {
    const title = titles.get(pane.id)
    return title === undefined ? pane : { ...pane, title }
  })
}
```

- [ ] **Step 7: Call it from restore**

`src/main/ipc/restore.ts:477` reads:

```ts
    return { projects, panes, tabs: tabRows, activeProjectId }
```

Wrap the `panes` value in `attachTitles(panes, <config>.panes)`, where `<config>` is whatever local that function already holds the config it read in. Import `attachTitles` from `./titles`, and add a one-line comment saying the titles are put back here because the descriptors came from the session manager, which does not carry them.

- [ ] **Step 8: Add the handler, and fix the same gap in moveTabToProject**

In `src/main/ipc/register.ts`, add beside the `moveTabToProject` handler:

```ts
  ipcMain.handle(CHANNELS.renameTab, (_event, id: string, title: string) =>
    serialise(async () => {
      const config = await store.read()
      const trimmed = title.trim()
      const panes = config.panes.map((row) =>
        row.id === id
          ? // An empty name is how a title is removed, so it is stored as
            // absent rather than as "": one representation on disk, and
            // `labelOfPane` never has to decide between them.
            { ...row, title: trimmed === '' ? undefined : trimmed }
          : row,
      )
      await store.write({ ...config, panes })
      // `manager.list()` is synchronous and returns `PaneRecord[]`, whose
      // shape `TabDescriptor` is a subset of; the existing `CHANNELS.list`
      // handler at register.ts:575 already returns it as descriptors.
      return attachTitles(manager.list(), panes)
    }),
  )
```

`store.read()` and `store.write({ ...config, panes })` are exactly the pair the `closePane` handler uses at `register.ts:319-322`; follow it.

Then make `moveTabToProject`'s handler pass its returned panes through `attachTitles(..., config.panes)` before answering, so a tab does not lose its name by being filed into another project. Import `attachTitles` from `./titles`.

- [ ] **Step 9: Bridge it**

In `src/preload/index.ts`, beside the `moveTabToProject` bridge:

```ts
  renameTab: (id, title) => ipcRenderer.invoke(CHANNELS.renameTab, id, title),
```

- [ ] **Step 10: Wire the renderer**

In `src/renderer/App.tsx`, add a callback beside the other mutations:

```ts
  const renameTab = useCallback(
    (id: string, title: string) => {
      window.prcli
        .renameTab(id, title)
        .then((panes) => dispatch({ type: 'renamedTab', panes }))
        .catch(fail)
    },
    [fail],
  )
```

and pass `onRename={renameTab}` to `<TabBar ...>`. `TabBar` does not accept that prop until Task 4, so add it to `TabBar`'s props there; for this task, adding the prop to the call site is enough only if it typechecks. If it does not, add the prop to `TabBar`'s signature now and leave it unused until Task 4.

- [ ] **Step 11: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck silent; vitest green.

- [ ] **Step 12: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/titles.ts src/main/ipc/restore.ts src/main/ipc/register.ts src/preload/index.ts src/renderer/workspace.ts src/renderer/App.tsx tests/unit/workspace.test.ts
git commit -m "Carry a tab name across the IPC boundary

An empty name is stored as an absent field rather than an empty string,
so there is one representation on disk and labelOfPane never has to
choose between two spellings of unnamed.

Titles are reattached to descriptors in one helper rather than threaded
through the session manager, which deals in tmux and has no business
knowing what a user called a tab. Filing a tab into another project goes
through the same helper, so a rename survives a move."
```

---

### Task 4: The two triggers

**Files:**
- Modify: `src/renderer/TabBar.tsx`
- Test: none of its own. Vitest is node-only here; Task 5 covers this through a real render.

**Interfaces:**
- Consumes: `labelOfPane` (Task 2); the `onRename: (id: string, title: string) => void` prop wired in Task 3.
- Produces: testids `tab-label-${id}`, `tab-rename-input-${id}`, `tabmenu-${id}` and `trename-${id}`, which Task 5's assertions name. The label needs its own testid because Task 5 double-clicks it, and the text it contains is the very thing under test.

Read `src/renderer/Sidebar.tsx`'s project rename before writing this. It is the pattern to follow, and it solves a problem you will otherwise hit: Enter and Escape both unmount the input, and Chromium does not reliably fire blur afterwards, so a naive handler commits twice or commits what Escape discarded. Its `editing` ref is what stops that.

- [ ] **Step 1: Add the editing state and the input**

Add to `TabBar`'s props: `onRename: (id: string, title: string) => void`.

Inside the component, mirror `Sidebar`'s three pieces of state: a `renamingId`, a `draft`, and an `editing` ref guarding double commits. Then replace the label span so that a tab being renamed shows an input instead:

```tsx
{renamingId === tab.id ? (
  <input
    data-testid={`tab-rename-input-${tab.id}`}
    // `App.tsx`'s ⌘ handler returns early inside this, and the comment
    // there records why: ⌘W typed while renaming used to close the tab and
    // kill its session, taking the half-typed name with it. Without this
    // attribute that bug simply moves to tabs.
    data-shortcuts="off"
    autoFocus
    value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={() => finishRename(tab.id, true)}
    onKeyDown={(event) => {
      if (event.key === 'Enter') finishRename(tab.id, true)
      if (event.key === 'Escape') finishRename(tab.id, false)
    }}
    // Stops the click that lands in the field from also re-activating the
    // tab underneath it.
    onClick={(event) => event.stopPropagation()}
    className="min-w-0 flex-1 border border-border bg-bg px-1 text-fg outline-none"
  />
) : (
  <span
    data-testid={`tab-label-${tab.id}`}
    onDoubleClick={(event) => {
      event.stopPropagation()
      startRename(tab)
    }}
    className={cn(dead[tab.id] !== undefined && 'line-through opacity-60')}
  >
    {labelOfPane(tab)}
  </span>
)}
```

`startRename` seeds `draft` with `tab.title ?? ''`, not with `labelOfPane(tab)`: opening the field on an unnamed tab should offer an empty box to type into, not the slug and id to delete first.

`finishRename(id, commit)` follows `Sidebar`'s shape exactly, with one deliberate difference: it does not require a non-empty name, because blank is how a name is cleared here.

```ts
const finishRename = (id: string, commit: boolean): void => {
  if (editing.current !== id) return
  editing.current = null
  setRenamingId(null)
  // No non-empty guard, unlike the project rename this copies: a blank name
  // is how a tab's name is removed, and a tab has a default to fall back to
  // where a project does not.
  if (commit) onRename(id, draft.trim())
}
```

- [ ] **Step 2: Add the context menu**

Add `onContextMenu` to the tab's container div, opening a one-item menu positioned over the bar:

```tsx
onContextMenu={(event) => {
  event.preventDefault()
  setMenuFor(tab.id)
}}
```

Render the menu as an absolutely positioned element so it does not stretch the 32px bar, with a single item:

```tsx
<button
  data-testid={`trename-${tab.id}`}
  onClick={(event) => {
    event.stopPropagation()
    setMenuFor(null)
    startRename(tab)
  }}
>
  Rename…
</button>
```

Give the menu container `data-testid={`tabmenu-${tab.id}`}`. Close it on any click elsewhere, the way `Sidebar` closes its own. Style it to match `Sidebar`'s menu: `border border-border bg-bg`, same text size as the bar.

A context menu rather than a visible `⋯` button: the bar is `h-8` and already carries a dot, a label, a close button and, for a dead tab, two more.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: silent, exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/TabBar.tsx
git commit -m "Let a tab be renamed by double-click or context menu

Both reach one input with one commit path. The commit rules are the
sidebar's, including the ref that stops a double commit, because Enter
and Escape both unmount the field and Chromium does not reliably follow
that with a blur.

The field opts out of the app's Cmd handler. Without that, Cmd+W typed
while renaming closes the tab and kills the session being named, which is
the bug that guard already exists for one surface up.

Blank commits rather than being ignored: it is how a name is cleared."
```

---

### Task 5: Prove the round trip

**Files:**
- Modify: `tests/e2e/tabs.spec.ts` (append a test; update the header's test count and summary)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

Read `tests/e2e/tabs.spec.ts`'s header comment fully before editing it. It counts and summarises every test in the file and records measured mutations with dates, and it has a house style to match rather than invent.

- [ ] **Step 1: Write the test**

Append to `tests/e2e/tabs.spec.ts`, following the file's existing helpers for launching and seeding:

```ts
test('a renamed tab shows its name in the bar and the sidebar, and survives a relaunch', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  // This file has no pane-id helper (`paneIds` lives in `splits.spec.ts` and
  // is not exported), and it already has the selector for the active tab, so
  // the id comes off that rather than a helper copied between files.
  const testid = await window.locator(ACTIVE_TAB).getAttribute('data-testid')
  const id = (testid ?? '').replace('tab-', '')
  expect(id).not.toBe('')

  // Double-click the label, type, commit.
  await window.getByTestId(`tab-label-${id}`).dblclick()
  const field = window.getByTestId(`tab-rename-input-${id}`)
  await field.fill('payments api')
  await field.press('Enter')

  // Both surfaces, which is the whole point: they read one selector over one
  // pane list, so a name that reaches the bar and not the sidebar means they
  // have drifted apart again.
  await expect(window.getByTestId(`tab-${id}`)).toContainText('payments api')
  await expect(window.getByTestId(`stab-${id}`)).toContainText('payments api')

  await app.close()

  // The half no unit test can reach: the name has to be on disk and come back
  // through restore, not merely live in the renderer's state.
  const second = await launch()
  const reopened = await second.firstWindow()
  await expect(reopened.getByTestId(`tab-${id}`)).toContainText('payments api')

  // Blank clears it, and both surfaces go back to slug and id.
  await reopened.getByTestId(`tab-label-${id}`).dblclick()
  const again = reopened.getByTestId(`tab-rename-input-${id}`)
  await again.fill('')
  await again.press('Enter')
  await expect(reopened.getByTestId(`tab-${id}`)).toContainText(id.slice(0, 6))
  await expect(reopened.getByTestId(`stab-${id}`)).toContainText(id.slice(0, 6))

  await second.close()
})

test('the context menu reaches the same rename field', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  const testid = await window.locator(ACTIVE_TAB).getAttribute('data-testid')
  const id = (testid ?? '').replace('tab-', '')

  await window.getByTestId(`tab-${id}`).click({ button: 'right' })
  await window.getByTestId(`trename-${id}`).click()

  // Two entry points into one path, so this only has to prove it arrives.
  await expect(window.getByTestId(`tab-rename-input-${id}`)).toBeVisible()

  await app.close()
})
```

`ACTIVE_TAB` is already declared at `tests/e2e/tabs.spec.ts:89` as `'[data-testid^="tab-"][data-active="true"]'`. `launch` is the file's own helper. Neither needs adding.

- [ ] **Step 2: Run them**

Run: `npx playwright test tests/e2e/tabs.spec.ts`
Expected: all pass, two more than before.

Roughly 1 launch in 20 dies before the window appears, a documented macOS flake, not your change. Re-run once before investigating a failure that looks like a launch that never produced a window. The tmux sockets are machine-global and another session may be running e2e; the same re-run-once rule applies.

- [ ] **Step 3: Measure that the tests bite**

Two mutations, both required to go red:

1. In `src/renderer/Sidebar.tsx`, change `{labelOfPane(tab)}` back to `{tab.projectSlug} · {tab.id.slice(0, 6)}`. Run the file. Expected: the first test fails at the `stab-` assertion, and only there. This is the sidebar half of the feature, and it is the half a bar-only implementation would silently omit.
2. In `src/main/ipc/register.ts`'s `renameTab` handler, drop the `store.write` call so the name lives only in the reply. Run the file. Expected: the first test fails after relaunch, at the reopened `tab-` assertion, not before it.

Restore after each and confirm the file is green again, with `git diff` empty against the committed version. Record both failures, quoting the assertion that failed, in your report. If either mutation leaves the file green, say so and stop: a test that cannot fail is worse than no test.

- [ ] **Step 4: Update the file's header**

Update the test count and add the two new tests to the header's summary list, in the position the file's own ordering puts them. Add a measured note in the house style, using the two results from Step 3 and stating plainly which assertion each mutation reddened.

Keep *Measured* and *Derived* separate, as `projects.spec.ts` now does: state only what the runs showed. Both of these are measured, so neither needs hedging, but do not describe either mutation as proving more than the assertion that actually failed.

- [ ] **Step 5: Full verification**

Run: `npm run typecheck && npm test && npx playwright test && npm run check-deps`
Expected: typecheck silent; vitest green; the whole e2e suite green; check-deps clean.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/tabs.spec.ts
git commit -m "Pin the rename in both surfaces and across a relaunch

Measured, both directions: reverting the sidebar to its own copy of the
label reddens the sidebar assertion alone, and dropping the store write
reddens only the assertion after relaunch. So the test tells a name that
never reached the sidebar apart from one that never reached disk."
```
