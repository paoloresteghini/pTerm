# Browser Region Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give browser panes a pane area of their own, a browser-only column to the right of the terminal column with its own tab bar, so a dev server and its page are on screen at once.

**Architecture:** Browser panes stay in `state.panes` and `state.tabs`. Which area a pane belongs to is derived from `pane.type`, never stored. Three `workspace.ts` derivations take a region argument, the reducer routes selection to a per-region active-id field, and the area itself is a new `ColumnId` slot so width, order, hide and show come from the column machinery that already exists.

**Tech Stack:** Electron 38, React 19, TypeScript, Tailwind v4, vitest (node environment), Playwright (Electron).

**Spec:** `docs/superpowers/specs/2026-08-11-browser-region-design.md` (commits 688d236, 5bb99ee).

## Global Constraints

- **No em dashes anywhere.** Not in code, comments, test names, commit messages, or the plan's own output. Use commas, colons, parentheses, or separate sentences.
- **Comments must be true of the branch, not just of the commit that writes them.** A comment describing behaviour that a later task changes is a defect. If a task changes behaviour a neighbouring comment describes, that comment is part of the task.
- **Do not prescribe comment text from this plan.** Where this plan shows a comment, it is showing intent. Write what is true when you get there, and verify it.
- **Verification is by running, not by reading.** Every step that claims a test fails or passes names the command and the expected output.
- **`vitest.config.mts` runs `environment: 'node'`.** There is no DOM in unit tests. Anything needing layout or React goes in a Playwright e2e spec, not a unit test.
- Commands: `npm test` (vitest), `npm run typecheck` (tsc), `npm run e2e` (Playwright).
- Run a single unit file with `npx vitest run tests/unit/<file>`; a single e2e test with `npx playwright test tests/e2e/<file> -g "<title>"`.
- **Before running e2e, reap stale test tmux servers.** They accumulate and cost real failures: `tmux -L pterm-test kill-server 2>/dev/null || true`. Never touch the `default` socket.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/renderer/BrowserColumn.tsx` | The region: collapse strip, its `TabBar`, and the browser panes it owns |
| `tests/unit/region.test.ts` | `regionOf`, the region-aware derivations, and the reducer's routing |
| `tests/e2e/browserRegion.spec.ts` | The region on screen: where it appears, what it does to the terminal bar, keys, persistence |

**Modified:**

| File | Change |
| --- | --- |
| `src/shared/ipc.ts` | `Region` and `regionOf` beside `canHaveSession`; `ProjectDescriptor.activeBrowserTabId`; `'browser'` in `ColumnId`; the `setActiveBrowser` channel |
| `src/renderer/workspace.ts` | Region argument on `tabsOfProject`, `activeTabId`, `paneGroups`; region routing in the reducer |
| `src/renderer/lib/columnOrder.ts` | `'browser'` in `COLUMN_ORDER_DEFAULT`, after `'terminal'` |
| `src/renderer/lib/columnVisibility.ts` | `'browser'` in `COLUMN_IDS` |
| `src/renderer/TabBar.tsx` | `testIdPrefix` and the capability flags |
| `src/renderer/App.tsx` | Two tab strips, `activeRegion`, key routing, the new slot in `renderSlot` |
| `src/main/state/store.ts` | `ProjectRecord.activeBrowserTabId` and its normalisation |
| `src/main/projects/projects.ts` | Default the new field on a new project |
| `src/main/ipc/restore.ts` | Resolve both active ids in `describeProjects`, with region-correct fallbacks |
| `src/main/ipc/register.ts` | Handle `setActiveBrowser` |
| `src/preload/*` | Expose `setActiveBrowser` on `window.pterm` |

---

### Task 1: The region predicate and the shared field

**Files:**
- Modify: `src/shared/ipc.ts` (beside `canHaveSession`, around line 145-175; `ProjectDescriptor` around line 655)
- Create: `tests/unit/region.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type Region = 'terminal' | 'browser'`
  - `export function regionOf(pane: { type: TabType }): Region`
  - `ProjectDescriptor.activeBrowserTabId?: string | null`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/region.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { regionOf, type TabType } from '../../src/shared/ipc'

const pane = (type: TabType) => ({ type })

describe('regionOf', () => {
  it('puts a browser pane in the browser region', () => {
    expect(regionOf(pane('browser'))).toBe('browser')
  })

  // The three kinds that stay put. Editor and diff are sessionless too, so a
  // predicate written against `canHaveSession` rather than against the kind
  // would move them, which is the one thing this design does not do.
  it('leaves every other kind in the terminal region', () => {
    for (const type of ['claude', 'preset', 'shell', 'editor', 'diff'] as TabType[]) {
      expect(regionOf(pane(type))).toBe('terminal')
    }
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/region.test.ts`
Expected: FAIL, `regionOf` is not exported by `src/shared/ipc.ts`.

- [ ] **Step 3: Add the predicate**

In `src/shared/ipc.ts`, immediately after `canHaveSession`:

```ts
export type Region = 'terminal' | 'browser'

export function regionOf(pane: { type: TabType }): Region {
  return pane.type === 'browser' ? 'browser' : 'terminal'
}
```

Write its doc comment yourself. What it needs to say, and what the reviewer will check it against: this is here rather than in `workspace.ts` for the reason `canHaveSession` gives just above it, that main asks the same question (`setActiveBrowser` picks a field by it), and that two spellings of "is this a browser" is how the two sides come to disagree.

- [ ] **Step 4: Add the descriptor field**

In `ProjectDescriptor`:

```ts
  activeBrowserTabId?: string | null
```

Optional, unlike `activeTabId` beside it, and the comment you write should say why: a large number of test files build these literals and a required field fails `tsc` in every one of them for no behaviour change. If you want to state the number, measure it first (`grep -rln "activeTabId:" tests/ | wc -l` reported 40 files on 2026-08-11, spanning both `ProjectDescriptor` and `ProjectRecord`) and say what you counted. Every read spells the absence as `?? null`.

- [ ] **Step 5: Run the test and the typecheck**

Run: `npx vitest run tests/unit/region.test.ts && npm run typecheck`
Expected: 2 passing, `tsc` silent.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts tests/unit/region.test.ts
git commit -m "Add the region predicate and the browser region's selection field"
```

---

### Task 2: Region-aware derivations in workspace.ts

**Files:**
- Modify: `src/renderer/workspace.ts` (`tabsOfProject` ~line 145, `activeTabId` ~line 154, `visibleGroupId` ~line 655, `paneGroups` ~line 706)
- Modify: `src/renderer/App.tsx` (the three call sites: lines ~466, ~472, ~479, plus `tabsOf` at ~1859)
- Test: `tests/unit/region.test.ts`

**Interfaces:**
- Consumes: `regionOf`, `Region` from Task 1.
- Produces:
  - `tabsOfProject(state, projectId, region?: Region)`, unfiltered when `region` is omitted
  - `activeTabId(state, region: Region = 'terminal')`
  - `paneGroups(state, region: Region = 'terminal')`

Every signature defaults to the behaviour it has today, so a call site not yet updated keeps compiling and keeps working. That is deliberate: it keeps this task's diff to the derivations plus the four call sites, and leaves nothing silently half-migrated, because the defaults are the old behaviour exactly.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/region.test.ts`. Build the state with the same shapes `tests/unit/workspace.test.ts` uses; read that file first and follow its helpers rather than inventing new ones.

```ts
import {
  INITIAL_WORKSPACE_STATE,
  activeTabId,
  paneGroups,
  tabsOfProject,
  type WorkspaceState,
} from '../../src/renderer/workspace'
import type { ProjectDescriptor, TabDescriptor, TabType } from '../../src/shared/ipc'

const project = (over: Partial<ProjectDescriptor> = {}): ProjectDescriptor => ({
  id: 'p1',
  name: 'demo',
  slug: 'demo',
  cwd: '/tmp/demo',
  presets: [],
  activeTabId: null,
  available: true,
  ...over,
})

const paneOf = (id: string, type: TabType): TabDescriptor => ({
  id,
  projectSlug: 'demo',
  cwd: '/tmp/demo',
  type,
  ...(type === 'browser' ? { url: 'http://localhost:5173/' } : {}),
})

const stateWith = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({
  ...INITIAL_WORKSPACE_STATE,
  projects: [project()],
  activeProjectId: 'p1',
  panes: [paneOf('t1', 'shell'), paneOf('b1', 'browser')],
  ...over,
})

describe('region-aware derivations', () => {
  it('splits one pane list into two strips', () => {
    const state = stateWith()
    expect(tabsOfProject(state, 'p1', 'terminal').map((pane) => pane.id)).toEqual(['t1'])
    expect(tabsOfProject(state, 'p1', 'browser').map((pane) => pane.id)).toEqual(['b1'])
  })

  // The default is the pre-change behaviour, which is what lets a call site
  // that has not been updated keep working rather than quietly losing panes.
  it('returns every pane when no region is named', () => {
    expect(tabsOfProject(stateWith(), 'p1').map((pane) => pane.id)).toEqual(['t1', 'b1'])
  })

  it('reads each region its own active id', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
    })
    expect(activeTabId(state, 'terminal')).toBe('t1')
    expect(activeTabId(state, 'browser')).toBe('b1')
  })

  it('reads a project that predates the field as no browser selection', () => {
    const state = stateWith({ projects: [project({ activeTabId: 't1' })] })
    expect(activeTabId(state, 'browser')).toBeNull()
  })

  it('boxes only its own region and shows that region its own active pane', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
    })
    const terminal = paneGroups(state, 'terminal')
    const browser = paneGroups(state, 'browser')
    expect(terminal.flatMap((group) => group.panes.map((box) => box.pane.id))).toEqual(['t1'])
    expect(browser.flatMap((group) => group.panes.map((box) => box.pane.id))).toEqual(['b1'])
    // Each region shows something. Before this change the single active id
    // could only make one of them visible.
    expect(terminal.some((group) => group.visible)).toBe(true)
    expect(browser.some((group) => group.visible)).toBe(true)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/region.test.ts`
Expected: FAIL. The signatures take no region yet, so the two-strip and per-region assertions fail on identical output.

- [ ] **Step 3: Add the region argument to the three derivations**

```ts
export function tabsOfProject(
  state: WorkspaceState,
  projectId: string,
  region?: Region,
): TabDescriptor[] {
  return state.panes.filter(
    (tab) =>
      projectIdForTab(state.projects, tab) === projectId &&
      (region === undefined || regionOf(tab) === region),
  )
}

export function activeTabId(state: WorkspaceState, region: Region = 'terminal'): string | null {
  const project = activeProject(state)
  if (!project) return null
  return (region === 'browser' ? project.activeBrowserTabId : project.activeTabId) ?? null
}
```

In `visibleGroupId` and `paneGroups`, thread the region through:

```ts
function visibleGroupId(state: WorkspaceState, region: Region): string | null {
  const id = activeTabId(state, region)
  if (id === null) return null
  return tabOfPane(state, id)?.id ?? id
}

export function paneGroups(state: WorkspaceState, region: Region = 'terminal'): PaneGroup[] {
  const visibleId = visibleGroupId(state, region)
  const groups: PaneGroup[] = []
  const seen = new Set<string>()
  const claimed = new Set<string>()
  for (const pane of state.panes) {
    if (regionOf(pane) !== region) continue
    // ... the rest of the existing body, unchanged
```

The `continue` goes at the top of the loop, before `tabOfPane`. A browser pane founds its own tab and never shares a row with a terminal, so no row can be half in one region and half in the other, and the `claimed` bookkeeping below it is unaffected.

- [ ] **Step 4: Update the four call sites in App.tsx**

- `const currentTabId = activeTabId(state)` stays as is; its default is `'terminal'`.
- `tabEntries` gains `'terminal'`: `groupedTabs(tabsOfProject(state, state.activeProjectId, 'terminal'), state.tabs)`.
- `const groups = paneGroups(state)` stays as is; its default is `'terminal'`.
- `Sidebar`'s `tabsOf` at ~line 1859 gains `'terminal'`, so the sidebar keeps listing exactly what the terminal bar lists.

- [ ] **Step 5: Run the tests, the whole suite, and the typecheck**

Run: `npm test && npm run typecheck`
Expected: the new file green, no regression in `tests/unit/workspace.test.ts`, `tsc` silent.

- [ ] **Step 6: Sabotage check, recorded**

Delete the `if (regionOf(pane) !== region) continue` line, run `npx vitest run tests/unit/region.test.ts`, and confirm the boxing test goes red. Restore the line. Note the observed failure message in the commit body. A test that cannot fail is worth nothing, and this is the line the whole task rests on.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/workspace.ts src/renderer/App.tsx tests/unit/region.test.ts
git commit -m "Derive tab strips, selection and pane boxes per region"
```

---

### Task 3: Reducer routing

**Files:**
- Modify: `src/renderer/workspace.ts` (`setActiveTab` ~line 953, `opened` ~line 1099, `activatedTab` ~line 1118, `closedPane` ~line 1226)
- Test: `tests/unit/region.test.ts`

**Interfaces:**
- Consumes: `regionOf` (Task 1), the region-aware derivations (Task 2).
- Produces: `workspaceReducer` writes a browser pane's selection to `activeBrowserTabId` and a terminal pane's to `activeTabId`, and picks a closed pane's replacement from within its own region.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/region.test.ts`:

```ts
import { workspaceReducer } from '../../src/renderer/workspace'

describe('reducer routing by region', () => {
  it('opening a browser pane does not move the terminal selection', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1' })],
      panes: [paneOf('t1', 'shell')],
    })
    const next = workspaceReducer(state, { type: 'opened', tab: paneOf('b1', 'browser') })
    expect(next.projects[0]?.activeTabId).toBe('t1')
    expect(next.projects[0]?.activeBrowserTabId).toBe('b1')
  })

  it('activating a terminal does not move the browser selection', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
      panes: [paneOf('t1', 'shell'), paneOf('t2', 'shell'), paneOf('b1', 'browser')],
    })
    const next = workspaceReducer(state, { type: 'activatedTab', id: 't2' })
    expect(next.projects[0]?.activeTabId).toBe('t2')
    expect(next.projects[0]?.activeBrowserTabId).toBe('b1')
  })

  // The selection rule that matters on close: the replacement comes from the
  // same region. Handing the browser region a terminal id would leave the
  // region drawing a pane it does not own, and the terminal region drawing
  // nothing.
  it('closing a browser pane selects the neighbouring browser, not a terminal', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
      panes: [paneOf('t1', 'shell'), paneOf('b1', 'browser'), paneOf('b2', 'browser')],
    })
    const next = workspaceReducer(state, {
      type: 'closedPane',
      paneId: 'b1',
      shape: { tabs: [], dropped: null },
    })
    expect(next.projects[0]?.activeBrowserTabId).toBe('b2')
    expect(next.projects[0]?.activeTabId).toBe('t1')
  })

  it('closing the last browser pane clears the browser selection only', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
      panes: [paneOf('t1', 'shell'), paneOf('b1', 'browser')],
    })
    const next = workspaceReducer(state, {
      type: 'closedPane',
      paneId: 'b1',
      shape: { tabs: [], dropped: null },
    })
    expect(next.projects[0]?.activeBrowserTabId).toBeNull()
    expect(next.projects[0]?.activeTabId).toBe('t1')
  })
})
```

Read the real `TabShape` and `JoinShape` in `src/shared/ipc.ts` before writing the `shape` literals above and match them exactly. The shape shown here is the "tab closed entirely" case; if the type spells it differently, the type wins.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/region.test.ts`
Expected: FAIL. Today every one of these writes `activeTabId`.

- [ ] **Step 3: Give `setActiveTab` a region**

```ts
function setActiveTab(
  state: WorkspaceState,
  projectId: string,
  activeTabId: string | null,
  region: Region = 'terminal',
): WorkspaceState {
  return {
    ...state,
    projects: state.projects.map((project) =>
      project.id !== projectId
        ? project
        : region === 'browser'
          ? { ...project, activeBrowserTabId: activeTabId }
          : { ...project, activeTabId },
    ),
  }
}
```

- [ ] **Step 4: Route the three cases**

- `opened`: `setActiveTab(..., owner, action.tab.id, regionOf(action.tab))`.
- `activatedTab`: `setActiveTab(state, projectIdForTab(state.projects, tab), action.id, regionOf(tab))`.
- `closedPane`: derive `const region = regionOf(closed)` after the existing `closed` lookup, compare against that region's current selection rather than `project?.activeTabId`, pass the region into `setActiveTab`, and filter the `neighbourOf` input to the same region:

```ts
      const region = regionOf(closed)
      const owner = projectIdForTab(state.projects, closed)
      const project = state.projects.find((candidate) => candidate.id === owner)
      const selected = region === 'browser' ? project?.activeBrowserTabId : project?.activeTabId
      if ((selected ?? null) !== action.paneId) return next
      return setActiveTab(
        next,
        owner,
        nextRow?.activePaneId ??
          neighbourOf(
            groupedTabs(tabsOfProject(state, owner, region), state.tabs).map((entry) => entry.pane),
            action.paneId,
          ),
        region,
      )
```

The existing comment above this block explains the pre-close grouped order and main's answer taking precedence. Both still hold; check that it does not also claim something this edit made false, and rewrite it if it does.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck`
Expected: green and silent. `tests/unit/workspace.test.ts` must be untouched and still passing: the region defaults keep every existing case on the terminal path.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/workspace.ts tests/unit/region.test.ts
git commit -m "Route pane selection to the region the pane belongs to"
```

---

### Task 4: Persist the browser region's selection

**Files:**
- Modify: `src/main/state/store.ts` (`ProjectRecord` ~line 33, `normaliseProject` ~line 329)
- Modify: `src/main/projects/projects.ts:51`
- Modify: `src/main/ipc/restore.ts` (`describeProjects` ~lines 30-50)
- Modify: `src/shared/ipc.ts` (the channel constant and the `window.pterm` surface)
- Modify: `src/main/ipc/register.ts` (beside the `CHANNELS.setActive` handler ~line 720)
- Modify: the preload that builds `window.pterm`
- Test: `tests/unit/region.test.ts` for `describeProjects`; follow `tests/integration/openBrowser.test.ts` for the channel

**Interfaces:**
- Consumes: `regionOf` (Task 1).
- Produces:
  - `ProjectRecord.activeBrowserTabId: string | null`
  - `window.pterm.setActiveBrowser(id: string | null): void`
  - `describeProjects` fills `activeBrowserTabId`, and `activeTabId`'s fallback no longer selects a browser pane

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/region.test.ts` (import `describeProjects` from `../../src/main/ipc/restore`; if that module pulls in Electron at import time, put this file's describe block in `tests/integration/` instead and follow the neighbouring integration tests):

```ts
describe('describeProjects', () => {
  it('resolves each region its own saved selection', async () => {
    const described = await describeProjects(
      [{ ...recordFor('p1'), activeTabId: 't1', activeBrowserTabId: 'b1' }],
      [paneOf('t1', 'shell'), paneOf('b1', 'browser')],
    )
    expect(described[0]?.activeTabId).toBe('t1')
    expect(described[0]?.activeBrowserTabId).toBe('b1')
  })

  // The fallback is the reason this test exists. `own[0]` is the project's
  // first pane in raw order, which after this change can be a browser, and a
  // terminal region pointed at a browser draws nothing at all.
  it('never falls back across the region boundary', async () => {
    const described = await describeProjects(
      [{ ...recordFor('p1'), activeTabId: null, activeBrowserTabId: null }],
      [paneOf('b1', 'browser'), paneOf('t1', 'shell')],
    )
    expect(described[0]?.activeTabId).toBe('t1')
    expect(described[0]?.activeBrowserTabId).toBe('b1')
  })

  it('leaves a region with no panes selecting nothing', async () => {
    const described = await describeProjects(
      [{ ...recordFor('p1'), activeTabId: null, activeBrowserTabId: null }],
      [paneOf('t1', 'shell')],
    )
    expect(described[0]?.activeBrowserTabId).toBeNull()
  })
})
```

Write `recordFor` against the real `ProjectRecord` in `src/main/state/store.ts`, including `presets: []` and whatever else it requires.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/region.test.ts`
Expected: FAIL, `activeBrowserTabId` is undefined on the described project, and the second test reports `activeTabId` as `'b1'`.

- [ ] **Step 3: Add the record field and its normalisation**

`src/main/state/store.ts`, on `ProjectRecord`:

```ts
  activeBrowserTabId: string | null
```

and in `normaliseProject`, beside the existing `activeTabId` line:

```ts
    activeBrowserTabId:
      typeof project.activeBrowserTabId === 'string' ? project.activeBrowserTabId : null,
```

`src/main/projects/projects.ts:51`, beside `activeTabId: null`:

```ts
    activeBrowserTabId: null,
```

- [ ] **Step 4: Resolve both in describeProjects**

```ts
    const own = tabs.filter((tab) => tab.projectSlug === project.slug)
    const terminals = own.filter((tab) => regionOf(tab) === 'terminal')
    const browsers = own.filter((tab) => regionOf(tab) === 'browser')
    described.push({
      // ... unchanged fields
      activeTabId:
        terminals.find((tab) => tab.id === project.activeTabId)?.id ?? terminals[0]?.id ?? null,
      activeBrowserTabId:
        browsers.find((tab) => tab.id === project.activeBrowserTabId)?.id ??
        browsers[0]?.id ??
        null,
      available: await isDirectory(project.cwd),
    })
```

The existing comment on the `activeTabId` line ("the saved choice when its session came back, else this project's first") is now false in one word: it is this project's first terminal. Fix it.

- [ ] **Step 5: Add the channel**

In `src/shared/ipc.ts`, add `setActiveBrowser` to `CHANNELS` and to the `window.pterm` interface next to `setActive`, matching its `(id: string | null): void` fire-and-forget shape. Document why it is a second channel rather than a parameter on `setActive`: `setActive` also drives `onActiveTabChanged`, which is what the status router reads to decide whether a pane is attended, so routing browser clicks through it would fire notifications for a terminal visible beside the page.

In `src/main/ipc/register.ts`, beside the `setActive` handler:

```ts
  ipcMain.on(CHANNELS.setActiveBrowser, (_event, id: string | null) => {
    void serialise(async () => {
      if (id === null) return
      const config = await store.read()
      const tab = config.panes.find((saved) => saved.id === id)
      if (!tab || regionOf(tab) !== 'browser') return
      const owner = projectForSlug(config, tab.projectSlug)
      if (!owner) return
      await store.write({
        ...config,
        projects: config.projects.map((project) =>
          project.id === owner.id ? { ...project, activeBrowserTabId: id } : project,
        ),
      })
    })
  })
```

Note what is deliberately absent: no `onActiveTabChanged` call. Add the same expose line in the preload that `setActive` has.

- [ ] **Step 6: Send it from the renderer**

In `App.tsx`, beside the existing effect that calls `window.pterm.setActive(currentTabId)` (~line 1136), add the browser one:

```ts
  const currentBrowserTabId = activeTabId(state, 'browser')
  useEffect(() => {
    window.pterm.setActiveBrowser(currentBrowserTabId)
  }, [currentBrowserTabId])
```

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck`
Expected: green and silent.

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc.ts src/main src/renderer/App.tsx tests/unit/region.test.ts
git commit -m "Persist the browser region's selection on its own channel"
```

---

### Task 5: The column slot

**Files:**
- Modify: `src/shared/ipc.ts` (`ColumnId` ~line 1430)
- Modify: `src/renderer/lib/columnOrder.ts` (`COLUMN_ORDER_DEFAULT`)
- Modify: `src/renderer/lib/columnVisibility.ts` (`COLUMN_IDS`)
- Test: `tests/unit/columnOrder.test.ts`, `tests/unit/columnVisibility.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `'browser'` is a `ColumnId`, sits after `'terminal'` in the default order, and is in `COLUMN_IDS`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/columnOrder.test.ts`:

```ts
  it('puts the browser region straight after the terminal by default', () => {
    const order = [...COLUMN_ORDER_DEFAULT]
    expect(order[order.indexOf('terminal') + 1]).toBe('browser')
  })

  // The upgrade path. Every profile on disk was written before this column
  // existed, and `orderFromStored` appends what a stored list never mentions.
  it('gains the browser slot from an order written before it existed', () => {
    const stored = JSON.stringify(COLUMN_ORDER_DEFAULT.filter((slot) => slot !== 'browser'))
    expect(orderFromStored(stored)).toContain('browser')
  })
```

Append to `tests/unit/columnVisibility.test.ts`:

```ts
  it('lists the browser column', () => {
    expect(COLUMN_IDS).toContain('browser')
  })

  // A profile written before this column existed has no key for it, and
  // `columnIsCollapsed` reads a missing key as collapsed. That is what makes
  // "hidden until the first browser opens" free rather than a migration.
  it('reads a profile with no browser key as collapsed', () => {
    expect(columnIsCollapsed({} as ColumnVisibility, 'browser')).toBe(true)
  })
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/columnOrder.test.ts tests/unit/columnVisibility.test.ts`
Expected: FAIL on the missing slot, plus a `tsc`-level complaint about `'browser'` not being a `ColumnId` when you run the typecheck.

- [ ] **Step 3: Add the slot**

Add `| 'browser'` to `ColumnId`, `'browser'` to `COLUMN_IDS`, and `'browser'` to `COLUMN_ORDER_DEFAULT` immediately after `'terminal'`.

- [ ] **Step 4: Run them and the typecheck**

Run: `npx vitest run tests/unit/columnOrder.test.ts tests/unit/columnVisibility.test.ts && npm run typecheck`
Expected: passing. `tsc` will now fail on `renderSlot` in `App.tsx`, whose `default` case assigns `slot` to `never`, and on any `Record<ColumnId, ...>` literal that is now missing a key. That failure is the point of that `default`. Fix each by adding the browser entry: for `renderSlot`, return `null` for now with a comment saying Task 7 fills it in.

- [ ] **Step 5: Run everything and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/shared/ipc.ts src/renderer/lib tests/unit
git commit -m "Add the browser column slot, hidden by default on every existing profile"
```

---

### Task 6: TabBar serves two bars

**Files:**
- Modify: `src/renderer/TabBar.tsx` (props ~lines 12-51, `tabbar` testid line 123, `tab-${tab.id}` line 168)
- Modify: `src/renderer/App.tsx` (the existing `<TabBar>` call ~line 1563)
- Test: `tests/e2e/browserRegion.spec.ts` covers it in Task 7; this task's own gate is the full existing e2e suite staying green

**Interfaces:**
- Consumes: nothing.
- Produces: `TabBar` accepts `testIdPrefix?: string` (default `'tab'`) and `capabilities?: { restart?: boolean; dismiss?: boolean; join?: boolean }` (each defaulting to `true`).

- [ ] **Step 1: Add the props**

```tsx
  testIdPrefix = 'tab',
  capabilities,
  ...
  testIdPrefix?: string
  capabilities?: { restart?: boolean; dismiss?: boolean; join?: boolean }
```

Document both props. What `testIdPrefix` needs to say, in whatever words are true when you write it: two bars exist now and only one may answer to `tab-`, because the e2e suite counts terminal tabs with `[data-testid^="tab-"]` and a second bar under that prefix inflates every one of those counts. Measured on 2026-08-11: 69 such locators across 12 spec files. Re-run `grep -rn 'data-testid\^="tab-"' tests/e2e/ | wc -l` before quoting a number, and quote what you measured. `capabilities` is off for the browser region because a sessionless pane cannot die, restart, or join.

Then: `data-testid={`${testIdPrefix}bar`}` on the bar, `` data-testid={`${testIdPrefix}-${tab.id}`} `` on each tab. Leave `elapsed-` and `tabinput-` alone: both are keyed by a pane id, which is unique across both bars, so neither can collide and neither is counted by a prefix locator.

Gate the restart glyph, the dismiss glyph and the join drop target on `capabilities?.restart !== false` and so on, so an omitted `capabilities` is exactly today's behaviour.

- [ ] **Step 2: Verify the default did not move**

Run: `npx playwright test tests/e2e/tabs.spec.ts` (and any other spec whose name suggests it counts tabs)
Expected: unchanged, green. If the suite is slow, run the full `npm run e2e` here rather than guessing which specs count tabs.

- [ ] **Step 3: Sabotage check, recorded**

Temporarily set the default `testIdPrefix` to `'browsertab'` and run one tab-counting e2e spec. Confirm it goes red. This proves the prefix is load bearing and that the existing locators really do depend on it. Restore the default, note the observed failure in the commit body.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/TabBar.tsx src/renderer/App.tsx
git commit -m "Let TabBar serve a second bar without colliding testids"
```

---

### Task 7: The region on screen

**Files:**
- Create: `src/renderer/BrowserColumn.tsx`
- Modify: `src/renderer/App.tsx` (`renderSlot`'s `'browser'` case, and the browser pane JSX moves with it)
- Create: `tests/e2e/browserRegion.spec.ts`

**Interfaces:**
- Consumes: `paneGroups(state, 'browser')`, `tabsOfProject(state, id, 'browser')`, `activeTabId(state, 'browser')`, `TabBar`'s `testIdPrefix` and `capabilities`.
- Produces: `<BrowserColumn>` rendering `data-testid="browser-column"` when open and `data-testid="browser-toggle"` when collapsed.

Read `src/renderer/NotesPanel.tsx` first and follow it: it is the closest existing column (a single non-list body, its own width key), and it shows the collapsed-strip-or-panel shape, `useColumnWidth`, and where `ColumnResizer` goes.

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/browserRegion.spec.ts`, following `tests/e2e/browser.spec.ts` for app launch and for opening a browser pane through the command palette:

```ts
test('a browser pane opens in its own region, not in the terminal bar', async () => {
  const terminalTabsBefore = await page.locator('[data-testid^="tab-"]').count()

  await openBrowserPaneViaPalette(page)

  await expect(page.getByTestId('browser-column')).toBeVisible()
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(1)
  // The assertion that actually proves the pane left the terminal bar. The
  // visibility check above passes just as well with the pane in both places.
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(terminalTabsBefore)
})
```

`toHaveCount` retries, so it waits for the count to reach the expected value. Where an assertion could be satisfied by the value it already had before the action (the third one here), add a positive assertion that only the action can satisfy (the first two, which run before it) so the test cannot pass by racing.

- [ ] **Step 2: Run it and watch it fail**

Run: `tmux -L pterm-test kill-server 2>/dev/null || true; npx playwright test tests/e2e/browserRegion.spec.ts`
Expected: FAIL, no `browser-column` testid exists.

- [ ] **Step 3: Write BrowserColumn**

Structure, with the parts you must copy from the existing pane JSX in `App.tsx` (~lines 1598-1700) rather than reinvent:

```tsx
export function BrowserColumn({
  groups,
  tabs,
  activeId,
  collapsed,
  onToggle,
  onDragStart,
  onActivate,
  onClose,
  onNew,
  onRename,
  onRecolor,
  side,
}: { /* ... */ }) {
  const { width, set, commit } = useColumnWidth('pterm:browserWidth', 480)

  if (collapsed) {
    return (
      <PanelStrip
        testid="browser-toggle"
        label="Browser"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
      />
    )
  }

  return (
    <div data-testid="browser-column" style={{ width }} className={/* follow NotesPanel */}>
      <ColumnResizer /* follow NotesPanel: side, width, set, commit */ />
      <TabBar
        testIdPrefix="browsertab"
        capabilities={{ restart: false, dismiss: false, join: false }}
        tabs={tabs}
        activeId={activeId}
        {/* status, since, now, dead, dirty: pass the empty objects. A browser
            pane is never in any of these maps. */}
        onActivate={onActivate}
        onClose={onClose}
        onNew={onNew}
        onRename={onRename}
        onRecolor={onRecolor}
        {/* onRestart, onDismiss, onJoin: required by the type and unreachable
            with the capabilities above. Pass no-ops. */}
      />
      <div className="relative min-h-0 flex-1">
        {groups.map((group) => (
          /* The same visibility-not-display rule the terminal groups follow,
             and the same never-unmount rule: a hidden browser pane keeps its
             page. Copy the group and box wrappers from App.tsx. */
        ))}
      </div>
    </div>
  )
}
```

`COLUMN_WIDTH_MAX` is 560 and `COLUMN_WIDTH_MIN` is 140 in `columnWidth.ts`; the 480 default sits inside that range, so no clamp changes are needed.

- [ ] **Step 4: Move the browser pane JSX and wire the slot**

In `App.tsx`'s `renderSlot`, replace the `'browser'` case's `null` with the component, fed from `paneGroups(state, 'browser')`, `groupedTabs(tabsOfProject(state, activeProjectId, 'browser'), state.tabs)` and `activeTabId(state, 'browser')`. The `<BrowserPane>` branch of the existing pane JSX now renders inside `BrowserColumn`; the terminal groups can no longer contain a browser pane, because Task 2 filters them out, so leaving that branch behind would leave dead code. Remove it and remove any import it orphaned.

- [ ] **Step 5: Run the test, then the whole suite**

Run: `npx playwright test tests/e2e/browserRegion.spec.ts` then `npm test && npm run typecheck && npm run e2e`
Expected: all green. Pay attention to `tests/e2e/splits.spec.ts`: its pixel constants encode the whole flex row, and a column that is open changes the terminal column's width. It should be unaffected here because the region is collapsed unless a browser is open, and no splits test opens one. If it does fail, that is real information about the default state, not a test to loosen.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/BrowserColumn.tsx src/renderer/App.tsx tests/e2e/browserRegion.spec.ts
git commit -m "Draw browser panes in a column of their own"
```

---

### Task 8: Auto-open, manual hide, per-project membership

**Files:**
- Modify: `src/renderer/App.tsx` (the visibility effects beside the existing `setColumnHidden` callbacks ~lines 341-390, and the `'browser'` case of `renderSlot`)
- Test: `tests/e2e/browserRegion.spec.ts`

**Interfaces:**
- Consumes: `tabsOfProject(state, id, 'browser')`, `setColumnHidden`.
- Produces: the region unhides on the first browser open, hides when the last closes, and draws nothing at all for a project with no browser panes.

- [ ] **Step 1: Write the failing tests**

Append to `tests/e2e/browserRegion.spec.ts`:

```ts
test('the region appears on the first browser and goes away with the last', async () => {
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible()
  await closeActiveBrowserTab(page)
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await expect(page.getByTestId('browser-toggle')).toBeHidden()
})

test('a manual hide leaves the browser alive and is undone by the next open', async () => {
  await openBrowserPaneViaPalette(page)
  await page.getByTestId('browser-heading').click()
  await expect(page.getByTestId('browser-column')).toBeHidden()
  await expect(page.getByTestId('browser-toggle')).toBeVisible()
  await openBrowserPaneViaPalette(page)
  await expect(page.getByTestId('browser-column')).toBeVisible()
  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(2)
})
```

Check `PanelHeading`'s testid convention against another column before writing `browser-heading`, and note that the heading and the strip may share a testid in this codebase: a blind click on a shared toggle testid is destructive, so assert on the panel's own state (`browser-column` visible or hidden) rather than on the toggle you clicked.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx playwright test tests/e2e/browserRegion.spec.ts`
Expected: FAIL, the column is either always drawn or never drawn.

- [ ] **Step 3: Implement the three rules**

```tsx
  const browserPanes = state.activeProjectId
    ? tabsOfProject(state, state.activeProjectId, 'browser')
    : []

  // Membership is per project, visibility is a global column preference.
  // Drawing nothing for a project with no browsers keeps an empty box off the
  // screen without touching the stored preference, so switching back to a
  // project that has one restores exactly what the user left.
  const showsBrowserRegion = browserPanes.length > 0
```

Auto-open: an effect keyed on the count of browser panes for the active project. When it rises from zero, `setColumnHidden('browser', false)`. When it falls to zero, `setColumnHidden('browser', true)`. Write it so a project switch cannot be mistaken for an open or a close: hold the previous count in a ref keyed by project id, or key the effect on both the id and the count and skip the run where the id changed.

In `renderSlot`'s `'browser'` case, return `null` when `!showsBrowserRegion`.

- [ ] **Step 4: Run the tests and the suite**

Run: `npx playwright test tests/e2e/browserRegion.spec.ts` then `npm test && npm run typecheck && npm run e2e`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx tests/e2e/browserRegion.spec.ts
git commit -m "Open the browser region with its first pane, hide it with its last"
```

---

### Task 9: Focus and keys

**Files:**
- Modify: `src/renderer/App.tsx` (`activeRegion` state, the keydown handler ~lines 1385-1490, the region wrappers)
- Modify: `src/renderer/BrowserColumn.tsx` (the focus wrapper)
- Test: `tests/e2e/browserRegion.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `activeRegion: Region` in `App.tsx` state, read by the ⌥1-9 and ⌘W branches.

- [ ] **Step 1: Measure the webview focus question before writing anything**

The spec flags this and it must be answered by running the app, not by reading the code. A click on page content inside a `<webview>` does not bubble into the host document; whether the host still sees `focusin` on the `<webview>` element is unknown.

Run the app (`npm start`), open a browser pane, and in the renderer devtools console run:

```js
document.addEventListener('focusin', (e) => console.log('focusin', e.target.tagName), true)
```

Click the page content inside the browser pane. Record what is logged.

- If `focusin` fires with `WEBVIEW`: use it, and say in the code comment that it was measured.
- If nothing is logged: fall back to main-side focus. The `<webview>`'s `WebContents` emits focus events reachable from main, and M1 already has a bridge to send events for a browser pane to the renderer. Extend that rather than inventing a poll.

Write the answer into the task's commit message either way. A handler that compiles and never fires is the exact defect M1 shipped in its popup handler and had to fix later.

- [ ] **Step 2: Write the failing tests**

```ts
test('Cmd-W closes the focused region', async () => {
  await openBrowserPaneViaPalette(page)
  const terminalTabs = await page.locator('[data-testid^="tab-"]').count()

  await page.getByTestId('browser-column').click()
  await page.keyboard.press('Meta+w')

  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(terminalTabs)
})

test('Opt-digit selects within the focused region', async () => {
  await openBrowserPaneViaPalette(page)
  await openBrowserPaneViaPalette(page)
  await page.getByTestId('browser-column').click()

  await page.keyboard.press('Alt+1')

  // Assert on the browser region's own active tab, and assert the terminal
  // region did not move. Read the active-tab attribute the bar already sets
  // rather than adding a new one.
})
```

Fill in the second test's assertion against whatever attribute `TabBar` already marks the active tab with; do not add a testid for it.

- [ ] **Step 3: Run them and watch them fail**

Run: `npx playwright test tests/e2e/browserRegion.spec.ts`
Expected: FAIL. ⌘W closes a terminal pane today no matter what was clicked.

- [ ] **Step 4: Implement**

- `const [activeRegion, setActiveRegion] = useState<Region>('terminal')`, not persisted.
- Set it to `'browser'` on focus entering the region (per Step 1's measured answer) and on a browser tab click or a browser pane opening; set it to `'terminal'` on the existing `selectPane` path and on a terminal tab click.
- Force it back: whenever the region is hidden or has no panes, `activeRegion` must read as `'terminal'`. Derive that rather than storing it (`const region = showsBrowserRegion && !hiddenColumns.browser ? activeRegion : 'terminal'`) so no effect can leave it stale.
- ⌘W: close the derived region's active pane.
- ⌥1-9: index the derived region's strip.
- ⌘T, ⌘D, ⇧⌘D and ⌘⌥ arrows stay on the terminal region. ⌘D and ⇧⌘D must no-op while the browser region is the derived one, since the region has no splits.

- [ ] **Step 5: Run the tests and the whole gate**

Run: `tmux -L pterm-test kill-server 2>/dev/null || true; npm test && npm run typecheck && npm run e2e`
Expected: all green. `verticalTabs.spec.ts:144` is a known pre-existing flake, measured at 1/9 before the browser pane branch and 2/9 after; if it fails, re-run it alone before treating it as yours.

- [ ] **Step 6: Commit**

```bash
git add src/renderer tests/e2e/browserRegion.spec.ts
git commit -m "Send the tab and close keys to whichever region has focus"
```

---

### Task 10: Cross-region drag guard, and the closing gate

**Files:**
- Modify: `src/renderer/TabBar.tsx` (the drag and drop handlers)
- Test: `tests/e2e/browserRegion.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a drag from one bar to the other is a no-op.

- [ ] **Step 1: Write the failing test**

```ts
test('a terminal tab cannot be dragged into the browser bar', async () => {
  await openBrowserPaneViaPalette(page)
  const browserTabs = await page.locator('[data-testid^="browsertab-"]').count()

  await page.locator('[data-testid^="tab-"]').first().dragTo(page.locator('[data-testid^="browsertab-"]').first())

  await expect(page.locator('[data-testid^="browsertab-"]')).toHaveCount(browserTabs)
  await expect(page.getByTestId('terminal-column')).toBeVisible()
})
```

A drag that is correctly rejected changes nothing, so this test passes trivially if the drag never happened at all. Before trusting it, confirm the same `dragTo` between two terminal tabs DOES do something in this app (the drag-tab-onto-tab split), so the gesture the test performs is one the app really receives.

- [ ] **Step 2: Run it, then implement the guard**

Reject a drop whose dragged pane and target pane are in different regions, in whatever handler `TabBar` uses for the drag-to-split join. Kinds do not move between regions, so this is a rejection, not a conversion.

- [ ] **Step 3: Full gate**

Run:

```bash
tmux -L pterm-test kill-server 2>/dev/null || true
npm test && npm run typecheck && npm run e2e
```

Expected: unit suite green, `tsc` silent, e2e green apart from the known `verticalTabs.spec.ts:144` flake.

- [ ] **Step 4: Open the app and use it**

Three defects in M1 passed every automated gate and were found only by launching the app. Do that here:

```bash
npm start
```

Check, and write down what you observed: the region appears when you open a browser and goes away when you close it; the divider drags and the width survives a relaunch; the active browser tab survives a relaunch; clicking into the page and pressing ⌘W closes the browser and not a terminal; switching to a project with no browsers draws no empty box, and switching back restores the one you left.

- [ ] **Step 5: Confirm no em dashes entered the branch**

Run: `git diff master...HEAD | grep -c '—'`
Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Reject a tab drag across the region boundary"
```

---

## Self-Review

**Spec coverage:** every section of the spec maps to a task. State model to Tasks 1-2, reducer to Task 3, persistence to Task 4, column plumbing to Task 5, the tab strip to Task 6, render to Task 7, visibility to Task 8, focus and keys to Task 9, the drag guard and the sabotage and manual gates to Tasks 6, 2 and 10.

**Known open question, deliberately not answered here:** whether `focusin` reaches the host from inside a `<webview>`. Task 9 Step 1 measures it and names the fallback. It is not a placeholder: the task cannot be written more precisely than that without running the app, and pretending otherwise would put an unverified claim in the plan.

**Type consistency:** `regionOf`, `Region`, `activeBrowserTabId`, `setActiveBrowser`, `testIdPrefix`, `capabilities`, `browser-column`, `browser-toggle` and the `browsertab-` prefix are spelled identically in every task that names them.
