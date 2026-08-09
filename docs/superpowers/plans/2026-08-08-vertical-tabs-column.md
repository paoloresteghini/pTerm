# Vertical Tabs Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a seventh side column that lists the active project's tabs with each tab's panes nested beneath it, replacing the horizontal tab bar while it is open.

**Architecture:** One new pure function (`tabTree`) beside the existing `groupedTabs` in `src/renderer/lib/tabGroups.ts`, one new predicate (`showsTabBar`) in `src/renderer/lib/columnVisibility.ts`, and one new component (`src/renderer/TabsPanel.tsx`) following the six existing panels. `App.tsx` gains a `'tabs'` column exactly like the other six and gates `<TabBar>` on the new predicate. No new IPC, no new persisted state beyond the two localStorage keys every column already has.

**Tech Stack:** TypeScript, React 19, Tailwind, Electron 43, vitest (`environment: 'node'`, no DOM), Playwright for e2e.

Design: `docs/superpowers/specs/2026-08-08-vertical-tabs-column-design.md`

## Global Constraints

- **Never use em dashes** in code, comments, copy, or commit messages. Use commas, colons, parentheses, or separate sentences.
- **Testid prefixes are counted across the suite.** New row testids MUST NOT begin with `tab-` (counted by 27+ locators), `pane-` (counted by `splits.spec.ts`), or `stab-` (owned by `Sidebar.tsx`). This column uses `vtab-` and `vpane-` only.
- **The tabs column defaults HIDDEN**, like every other column. This is what keeps `splits.spec.ts` and the rest of the suite untouched.
- **Comments must be true.** If a step's comment states a measurement, that measurement must have been taken. Do not transcribe a claim you have not verified.
- **Sabotage every new test.** Break the code, `diff` to confirm the mutation actually landed, confirm the test goes red, restore. A line-number-based edit that silently matched nothing has produced a false green in this repo before.
- **`grep` here is ugrep.** `-Z` is fuzzy-match, not NUL-separator. Shell globs like `--include=*.ts` fail under this zsh; quote them or use plain `grep -rn pattern dir`.
- Gates: `npm run typecheck`, `npm test`, `npm run e2e`.

---

### Task 1: `tabTree` — the nested row model

**Files:**
- Modify: `src/renderer/lib/tabGroups.ts` (append; do not touch `groupedTabs`)
- Test: `tests/unit/tabGroups.test.ts` (append)

**Interfaces:**
- Consumes: `TabDescriptor`, `TabRow` from `src/shared/ipc` (already imported by this file).
- Produces:
  ```ts
  export interface TabTreeNode {
    pane: TabDescriptor
    children: TabDescriptor[]
  }
  export function tabTree(panes: TabDescriptor[], rows: TabRow[]): TabTreeNode[]
  ```

Rules, all of which the tests below pin:
- Walk `panes` in the order given. Emit a node the first time a pane is reached that has not already been emitted as part of a row.
- A pane whose id is in no row's `layout.kids` emits a node with no children.
- For a row, the parent is the pane whose id is `row.id`; if that pane is not among the row's present kids, the parent is the first present kid. Children are the row's other present kids, in `kids` order.
- A `kids` entry absent from `panes` never appears, matching `groupedTabs` and `panesOfTab`.
- Pane-to-row resolution is FIRST-WINS, matching `groupedTabs`' existing `rowByPaneId` loop.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/tabGroups.test.ts`. Note the existing file already imports from `'../../src/renderer/lib/tabGroups'`; add `tabTree` to that import rather than adding a second import line.

```ts
describe('tabTree', () => {
  // A minimal pane. The real TabDescriptor has many more fields; only `id` is
  // read by tabTree, and building the full shape here would tie these tests to
  // fields they say nothing about.
  const pane = (id: string): TabDescriptor => ({ id }) as TabDescriptor
  const row = (id: string, kids: string[]): TabRow => ({ id, kids }) as unknown as TabRow

  it('gives a pane in no row a node of its own with no children', () => {
    expect(tabTree([pane('a')], [])).toEqual([{ pane: pane('a'), children: [] }])
  })

  it('gives a row holding one pane no children, so a plain tab grows no twist', () => {
    expect(tabTree([pane('a')], [row('a', ['a'])])).toEqual([
      { pane: pane('a'), children: [] },
    ])
  })

  it('nests a row\'s other kids under its founding pane, in kids order', () => {
    const tree = tabTree(
      [pane('a'), pane('b'), pane('c')],
      [row('a', ['a', 'b', 'c'])],
    )
    expect(tree).toEqual([
      { pane: pane('a'), children: [pane('b'), pane('c')] },
    ])
  })

  it('anchors a group at its earliest member, not at the founding pane', () => {
    // `applyTabShape` appends new panes, so a split of the first of two tabs
    // puts its sibling last in `panes`. The group must still draw where its
    // earliest member sat.
    const tree = tabTree(
      [pane('a'), pane('z'), pane('b')],
      [row('a', ['a', 'b'])],
    )
    expect(tree.map((node) => node.pane.id)).toEqual(['a', 'z'])
    expect(tree[0].children.map((kid) => kid.id)).toEqual(['b'])
  })

  it('promotes the first present kid when the founding pane is gone', () => {
    // Reachable: the founding pane can be closed while its siblings live on.
    // `TabRow.id` is never rewritten, so it can name a pane that is no longer
    // in the tab.
    const tree = tabTree([pane('b'), pane('c')], [row('a', ['a', 'b', 'c'])])
    expect(tree).toEqual([{ pane: pane('b'), children: [pane('c')] }])
  })

  it('drops a kid that is not among the panes given', () => {
    // Another project's pane, or one main has since dropped.
    const tree = tabTree([pane('a')], [row('a', ['a', 'gone'])])
    expect(tree).toEqual([{ pane: pane('a'), children: [] }])
  })

  it('resolves a pane claimed by two rows to the first, matching groupedTabs', () => {
    const tree = tabTree([pane('a')], [row('r1', ['a']), row('r2', ['a'])])
    expect(tree).toEqual([{ pane: pane('a'), children: [] }])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/tabGroups.test.ts`
Expected: FAIL. The import of `tabTree` does not resolve, so the whole file errors rather than individual assertions failing.

- [ ] **Step 3: Write the implementation**

Append to `src/renderer/lib/tabGroups.ts`:

```ts
/**
 * One node per tab, with that tab's other panes nested under it.
 *
 * The nested counterpart to `groupedTabs`, from the same two inputs and using
 * the same first-wins pane-to-row convention, and living in this file so the
 * flat and nested readings of "what is a group" cannot drift apart.
 *
 * The parent is a PANE, not the row. `TabRow` carries no name of its own: a
 * title lives on `TabDescriptor.title` and `renameTab` renames a pane, so a row
 * has nothing to label itself with. The founding pane (`TabRow.id`) is the
 * parent, which is also what a terminal list looks like elsewhere: a terminal
 * with its splits beneath it, not an abstract heading.
 *
 * `TabRow.id` is never rewritten, so it can name a pane that has since been
 * closed while its siblings live on. The first present kid is promoted in that
 * case, because a tab whose panes are all still open must not lose its node.
 */
export interface TabTreeNode {
  pane: TabDescriptor
  children: TabDescriptor[]
}

export function tabTree(panes: TabDescriptor[], rows: TabRow[]): TabTreeNode[] {
  const byId = new Map(panes.map((pane) => [pane.id, pane]))
  const rowByPaneId = new Map<string, TabRow>()
  // First-wins, the same rule `groupedTabs` above applies, for the same reason.
  for (const row of rows) {
    for (const kid of row.layout.kids) {
      if (!rowByPaneId.has(kid)) rowByPaneId.set(kid, row)
    }
  }

  const emitted = new Set<string>()
  const nodes: TabTreeNode[] = []

  for (const pane of panes) {
    if (emitted.has(pane.id)) continue

    const row = rowByPaneId.get(pane.id)
    if (!row) {
      emitted.add(pane.id)
      nodes.push({ pane, children: [] })
      continue
    }

    // In `kids` order and present only, so a kid belonging to another project
    // or since dropped by main never reaches the screen.
    const present = row.layout.kids
      .map((kid) => byId.get(kid))
      .filter((kid): kid is TabDescriptor => kid !== undefined)
    for (const kid of present) emitted.add(kid.id)

    const founder = present.find((kid) => kid.id === row.id) ?? present[0]
    nodes.push({
      pane: founder,
      children: present.filter((kid) => kid.id !== founder.id),
    })
  }

  return nodes
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/tabGroups.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Sabotage each new test**

For each mutation: apply it, `diff` the file to confirm it landed, run the tests, confirm the expected test goes red, then restore. Record the observed result.

| Mutation | Expected red |
|---|---|
| `?? present[0]` becomes `?? present[present.length - 1]` | promotes the first present kid |
| `present.filter((kid) => kid.id !== founder.id)` becomes `present` | nests a row's other kids |
| drop the `if (!rowByPaneId.has(kid))` guard so last-wins | resolves a pane claimed by two rows |
| `.filter((kid): kid is TabDescriptor => kid !== undefined)` removed (cast the map result) | drops a kid that is not among the panes given |

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/renderer/lib/tabGroups.ts tests/unit/tabGroups.test.ts
git commit -m "Nest a tab's panes under the pane that founded it"
```

---

### Task 2: `'tabs'` becomes a column id

**Files:**
- Modify: `src/shared/ipc.ts` (the `ColumnId` union, currently one line)
- Modify: `src/renderer/lib/columnVisibility.ts` (`COLUMN_IDS`)
- Test: `tests/unit/columnVisibility.test.ts:28` (the exact-array assertion)

**Interfaces:**
- Produces: `ColumnId` gains `'tabs'`; `COLUMN_IDS` gains `'tabs'` in on-screen order (immediately after nothing else, i.e. FIRST, since this column sits leftmost beside the sidebar).

- [ ] **Step 1: Update the failing assertion first, and watch it fail**

In `tests/unit/columnVisibility.test.ts`, change line 28 from:

```ts
    expect(COLUMN_IDS).toEqual(['files', 'skills', 'presets', 'prompts', 'git', 'notes'])
```

to:

```ts
    // `tabs` leads because the column sits leftmost, immediately right of the
    // projects sidebar, and this array is documented as on-screen order.
    expect(COLUMN_IDS).toEqual(['tabs', 'files', 'skills', 'presets', 'prompts', 'git', 'notes'])
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/columnVisibility.test.ts`
Expected: FAIL on `COLUMN_IDS`, received the six-item array.

- [ ] **Step 3: Add the id in both places**

In `src/shared/ipc.ts`, change the `ColumnId` union to:

```ts
export type ColumnId = 'tabs' | 'files' | 'skills' | 'presets' | 'prompts' | 'notes' | 'git'
```

In `src/renderer/lib/columnVisibility.ts`, change `COLUMN_IDS` to:

```ts
/** Left to right as they appear on screen, which is the order the menu lists. */
export const COLUMN_IDS: readonly ColumnId[] = [
  'tabs',
  'files',
  'skills',
  'presets',
  'prompts',
  'git',
  'notes',
]
```

- [ ] **Step 4: Run the unit suite**

Run: `npm run typecheck && npx vitest run tests/unit/columnVisibility.test.ts`
Expected: typecheck PASSES (every `Record<ColumnId, ...>` is now required to have a `tabs` key, so any that does not will error here and must be given one), tests PASS.

If typecheck reports a missing `tabs` key in `HIDDEN_KEYS` in `src/renderer/App.tsx`, that is expected and is fixed in Task 3. Leave it failing and move on only if the sole errors are in `App.tsx`; fix anything else here.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/renderer/lib/columnVisibility.ts tests/unit/columnVisibility.test.ts
git commit -m "Make room for a seventh column"
```

---

### Task 3: `showsTabBar`, and wiring the column's state into App

**Files:**
- Modify: `src/renderer/lib/columnVisibility.ts` (add `showsTabBar`)
- Modify: `src/renderer/App.tsx` (`HIDDEN_KEYS`, a `TABS_KEY`, collapse state, the `<TabBar>` gate)
- Test: `tests/unit/columnVisibility.test.ts`

**Interfaces:**
- Consumes: `ColumnId`, `ColumnVisibility` from Task 2.
- Produces: `export function showsTabBar(collapsed: ColumnVisibility, hidden: Record<ColumnId, boolean>): boolean`

The rule: the horizontal bar shows unless the tabs column is fully open. "Open" means not hidden and not collapsed. Note `ColumnVisibility`'s booleans mean COLLAPSED, not visible.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/columnVisibility.test.ts`:

```ts
describe('showsTabBar', () => {
  const allCollapsed: ColumnVisibility = {
    tabs: true, files: true, skills: true, presets: true, prompts: true, git: true, notes: true,
  }
  const noneHidden: Record<ColumnId, boolean> = {
    tabs: false, files: false, skills: false, presets: false, prompts: false, git: false, notes: false,
  }

  it('shows the bar when the tabs column is collapsed to its strip', () => {
    expect(showsTabBar(allCollapsed, noneHidden)).toBe(true)
  })

  it('shows the bar when the tabs column is hidden outright', () => {
    expect(showsTabBar({ ...allCollapsed, tabs: false }, { ...noneHidden, tabs: true })).toBe(true)
  })

  it('hides the bar only when the tabs column is fully open', () => {
    expect(showsTabBar({ ...allCollapsed, tabs: false }, noneHidden)).toBe(false)
  })

  it('ignores every other column', () => {
    // A guard against reading the wrong key: opening all six of the others
    // must not touch the bar. Without this, `some(id => !state[id])` would
    // pass the other three tests and still be wrong.
    const othersOpen: ColumnVisibility = {
      tabs: true, files: false, skills: false, presets: false, prompts: false, git: false, notes: false,
    }
    expect(showsTabBar(othersOpen, noneHidden)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/columnVisibility.test.ts`
Expected: FAIL, `showsTabBar` is not exported.

- [ ] **Step 3: Implement `showsTabBar`**

Append to `src/renderer/lib/columnVisibility.ts`:

```ts
/**
 * Whether the horizontal tab bar should be on screen.
 *
 * The bar shows unless the tabs column is fully OPEN, which is the one rule
 * that keeps a tab always reachable: every state that takes the column away
 * (collapsed to its strip, or hidden by the View menu) puts the bar back, so
 * there is no combination in which the workspace has no tab surface at all.
 *
 * Remember that `ColumnVisibility`'s booleans mean COLLAPSED, not visible, so
 * open is `!collapsed.tabs && !hidden.tabs`.
 */
export function showsTabBar(
  collapsed: ColumnVisibility,
  hidden: Record<ColumnId, boolean>,
): boolean {
  return collapsed.tabs || hidden.tabs
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/columnVisibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Sabotage**

Apply each, `diff` to confirm it landed, run, confirm red, restore:

| Mutation | Expected red |
|---|---|
| `return collapsed.tabs \|\| hidden.tabs` becomes `return collapsed.tabs` | shows the bar when the tabs column is hidden outright |
| becomes `return anyOpen(collapsed)` | ignores every other column |
| becomes `return true` | hides the bar only when the tabs column is fully open |

- [ ] **Step 6: Wire the column's two flags into App.tsx**

In `src/renderer/App.tsx`, beside the existing `SKILLS_KEY` block, add:

```ts
const TABS_KEY = 'pterm:tabsCollapsed'
```

Add the seventh entry to `HIDDEN_KEYS` (this is the typecheck error Task 2 left behind):

```ts
const HIDDEN_KEYS: Record<ColumnId, string> = {
  tabs: 'pterm:tabsHidden',
  files: 'pterm:filesHidden',
  skills: 'pterm:skillsHidden',
  presets: 'pterm:presetsHidden',
  prompts: 'pterm:promptsHidden',
  git: 'pterm:gitHidden',
  notes: 'pterm:notesHidden',
}
```

Add the collapse state beside the other six, following the exact pattern already used for `notesCollapsed` (find it by searching for `NOTES_KEY` and copy its `useState`/`storedCollapsed` shape, defaulting COLLAPSED like every other column).

- [ ] **Step 7: Gate the tab bar**

In `src/renderer/App.tsx`, import `showsTabBar` from `./lib/columnVisibility`, then wrap the existing `<TabBar ... />` element (it begins at roughly line 1393, inside `<div className="flex min-w-0 flex-1 flex-col">`) so it renders only when the predicate says so:

```tsx
{showsTabBar(collapsedColumns, hiddenColumns) ? (
  <TabBar
    /* every existing prop unchanged */
  />
) : null}
```

`hiddenColumns` already exists in this component. If a `ColumnVisibility`-shaped collapsed object does not already exist beside it, build one from the six `*Collapsed` booleans plus the new `tabsCollapsed`, next to where `columnsVisible` is sent to main, and reuse it for both.

- [ ] **Step 8: Verify nothing moved yet**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean, all unit tests pass. The column has no component yet, so the app is unchanged on screen: `tabs` defaults hidden, so `showsTabBar` returns true and the bar renders exactly as before.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/lib/columnVisibility.ts src/renderer/App.tsx tests/unit/columnVisibility.test.ts
git commit -m "Give the tab bar a reason to stand down"
```

---

### Task 4: `TabsPanel`

**Files:**
- Create: `src/renderer/TabsPanel.tsx`
- Modify: `src/renderer/App.tsx` (render it)

**Interfaces:**
- Consumes: `tabTree`, `TabTreeNode` (Task 1); `StatusDot` from `./StatusDot`; `elapsedLabel` from `./lib/elapsed`; `tabLabel` from `./lib/tabLabel`; `useColumnWidth` from `./lib/columnWidth`; `ColumnResizer`, `PanelHeading`, `PanelStrip` from `./ui/Panel`; `cn` from `./lib/cn`.
- Produces:
  ```tsx
  export function TabsPanel(props: {
    nodes: TabTreeNode[]
    activeId: string | null
    status: Record<string, TabState>
    since: Record<string, number>
    now: number
    collapsed: boolean
    onToggle: () => void
    onSelect: (paneId: string) => void
    onClose: (paneId: string) => void
  }): JSX.Element
  ```

Read `src/renderer/NotesPanel.tsx` in full before writing this. It is the smallest of the six panels and shows the exact `PanelStrip` / `PanelHeading` / `ColumnResizer` / `useColumnWidth` arrangement every column follows. Match it rather than inventing a layout.

- [ ] **Step 1: Write the component**

Testids: the container is `tabs-panel`, the strip is `tabs-toggle` (matching `git-panel` / `git-toggle`), a tab row is `` `vtab-${pane.id}` ``, a child row is `` `vpane-${pane.id}` ``, and a close control is `` `vclose-${pane.id}` ``. None of these begin with `tab-`, `pane-`, or `stab-`.

```tsx
import { useState } from 'react'
import type { TabDescriptor, TabState } from '../shared/ipc'
import type { TabTreeNode } from './lib/tabGroups'
import { StatusDot } from './StatusDot'
import { elapsedLabel } from './lib/elapsed'
import { tabLabel } from './lib/tabLabel'
import { useColumnWidth } from './lib/columnWidth'
import { ColumnResizer, PanelHeading, PanelStrip } from './ui/Panel'
import { cn } from './lib/cn'

/**
 * The active project's tabs, with each tab's other panes nested beneath it.
 *
 * The vertical answer to a bar that ran out of room: measured 2026-08-08, past
 * roughly fifteen tabs the bar scrolls and puts `+` behind itself. A list
 * scrolls without limit, and unlike a bar it has somewhere to put a child, so a
 * split reads as belonging to its tab rather than as a neighbour of it.
 *
 * `App.tsx` renders the bar only while this column is not open, so the two are
 * never on screen together and cannot disagree.
 */
export function TabsPanel({
  nodes,
  activeId,
  status,
  since,
  now,
  collapsed,
  onToggle,
  onSelect,
  onClose,
}: {
  nodes: TabTreeNode[]
  activeId: string | null
  status: Record<string, TabState>
  since: Record<string, number>
  now: number
  collapsed: boolean
  onToggle: () => void
  onSelect: (paneId: string) => void
  onClose: (paneId: string) => void
}) {
  const { width, set, commit } = useColumnWidth('pterm:tabsWidth', 208)
  // Which tabs are twisted shut. Local and not persisted: it is a glance-level
  // gesture, and a collapsed tab that survived a relaunch would hide panes the
  // user has forgotten they closed the twist on.
  const [shut, setShut] = useState<Set<string>>(() => new Set())

  if (collapsed) return <PanelStrip testid="tabs-toggle" label="Tabs" side="left" onClick={onToggle} />

  const row = (pane: TabDescriptor, depth: number, last: boolean, hasKids: boolean) => {
    const label = elapsedLabel(since[pane.id] ?? null, now)
    return (
      <div
        key={pane.id}
        data-testid={depth === 0 ? `vtab-${pane.id}` : `vpane-${pane.id}`}
        onClick={() => onSelect(pane.id)}
        className={cn(
          'group flex cursor-default items-center gap-1 py-0.5 pr-1 text-[11px]',
          pane.id === activeId ? 'bg-surface text-fg' : 'text-muted hover:text-fg',
        )}
        style={{ paddingLeft: depth === 0 ? 8 : 20 }}
      >
        {depth > 0 ? (
          <span aria-hidden className="shrink-0 font-mono text-faint">{last ? '└' : '├'}</span>
        ) : null}
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-sm border border-border"
          style={{ background: pane.color ?? undefined }}
        />
        <span className="flex-1 truncate">{tabLabel(pane)}</span>
        {label === null ? null : <span className="shrink-0 text-faint">{label}</span>}
        <StatusDot state={status[pane.id] ?? null} testid={`vdot-${pane.id}`} />
        <button
          data-testid={`vclose-${pane.id}`}
          aria-label={`Close ${tabLabel(pane)}`}
          className="shrink-0 cursor-default border-none bg-transparent px-1 text-faint opacity-0 group-hover:opacity-100 hover:text-fg"
          onClick={(event) => {
            // Or the row's own click would select the pane on its way out.
            event.stopPropagation()
            onClose(pane.id)
          }}
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <div
      data-testid="tabs-panel"
      className="relative flex shrink-0 flex-col border-r border-border bg-bg"
      style={{ width }}
    >
      <PanelHeading testid="tabs-heading" label="Tabs" onClick={onToggle} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {nodes.map((node) => (
          <div key={node.pane.id}>
            {node.children.length === 0 ? null : (
              <button
                data-testid={`vtwist-${node.pane.id}`}
                aria-label={shut.has(node.pane.id) ? 'Expand' : 'Collapse'}
                className="absolute cursor-default border-none bg-transparent text-faint"
                onClick={() =>
                  setShut((previous) => {
                    const next = new Set(previous)
                    if (!next.delete(node.pane.id)) next.add(node.pane.id)
                    return next
                  })
                }
              >
                {shut.has(node.pane.id) ? '▸' : '▾'}
              </button>
            )}
            {row(node.pane, 0, false, node.children.length > 0)}
            {shut.has(node.pane.id)
              ? null
              : node.children.map((kid, index) =>
                  row(kid, 1, index === node.children.length - 1, false),
                )}
          </div>
        ))}
      </div>
      <ColumnResizer testid="tabs-resizer" side="left" width={width} onResize={set} onCommit={commit} />
    </div>
  )
}
```

- [ ] **Step 2: Render it from App**

In `src/renderer/App.tsx`, immediately after `<Sidebar ... />` and before the `<div className="flex min-w-0 flex-1 flex-col">` that holds the tab bar, add:

```tsx
{hiddenColumns.tabs ? null : (
  <TabsPanel
    nodes={tabTree(tabEntries.map((entry) => entry.pane), state.tabs)}
    activeId={activePaneId}
    status={state.status}
    since={state.since}
    now={now}
    collapsed={tabsCollapsed}
    onToggle={() => toggleColumnCollapsed('tabs')}
    onSelect={selectPane}
    onClose={requestClosePane}
  />
)}
```

Import `TabsPanel` from `./TabsPanel` and `tabTree` from `./lib/tabGroups`.

`tabEntries` is already the active project's panes (it is `groupedTabs`' output); mapping to `.pane` recovers the flat pane list `tabTree` wants. `state.tabs` is the `TabRow[]`. `selectPane` and `requestClosePane` both already exist in this component.

- [ ] **Step 3: Verify by running the app, not only the tests**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, unit tests pass.

Then confirm on screen, because the suite cannot see a layout:

```bash
npm start
```

With the app open: the View menu has a Tabs item; enabling it shows the column and the horizontal bar disappears; a `⌘D` split shows the new pane nested under its tab with a connector; clicking a child moves the cursor to that pane; the twist hides and shows children; the close control removes a pane; collapsing the column to its strip brings the bar back.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/TabsPanel.tsx src/renderer/App.tsx
git commit -m "List tabs down the side, with each split beneath its tab"
```

---

### Task 5: The View menu item

**Files:**
- Modify: `src/shared/ipc.ts` (`MenuCommand` union)
- Modify: `src/main/index.ts` (the View menu block, and `showColumns`)
- Modify: `src/renderer/App.tsx` (the menu-command handler)

**Interfaces:**
- Consumes: `setColumnHidden`, `hiddenColumns` (already in `App.tsx`).
- Produces: `MenuCommand` gains `'toggleTabs'`; a menu item with id `toggle-tabs`.

- [ ] **Step 1: Add the command to the union**

In `src/shared/ipc.ts`, add `| 'toggleTabs'` to `MenuCommand`, beside `'toggleFiles'`.

- [ ] **Step 2: Add the menu item**

In `src/main/index.ts`, in the View menu's column block, add an item ahead of `toggle-files` so the menu lists columns in on-screen order:

```ts
{
  id: 'toggle-tabs',
  label: 'Tabs',
  type: 'checkbox',
  // No accelerator. The six lettered columns have spent the mnemonic keys, and
  // this one replaces the tab bar rather than merely appearing beside it, which
  // is not a change to make by a keystroke a hand can land on by accident.
  registerAccelerator: false,
  click: () => sendMenuCommand('toggleTabs'),
},
```

Then find `showColumns` in the same file and give it the `tabs` case alongside the existing six, following exactly what it does for `notes`.

- [ ] **Step 3: Handle it in the renderer**

In `src/renderer/App.tsx`, beside the existing `toggleNotes` handler (search for `setColumnHidden('notes'`), add the matching callback for `tabs` and wire it into the `onMenuCommand` switch as `case 'toggleTabs'`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npx playwright test tests/e2e/menuColumns.spec.ts`
Expected: all pass. `menuColumns.spec.ts` clicks items by id and asserts specific panels; it never enumerates the menu, so a seventh entry is invisible to it. If it fails, read the failure before changing it: the spec is not expected to need editing.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/index.ts src/renderer/App.tsx
git commit -m "Put the tabs column on the View menu"
```

---

### Task 6: End-to-end coverage

**Files:**
- Create: `tests/e2e/verticalTabs.spec.ts`

**Interfaces:**
- Consumes: `launchApp`, `killServer`, `sessionNames` from `./harness`; testids from Task 4.

Model the file's setup on `tests/e2e/webgl.spec.ts`, which is the newest spec and already has the temp-dir `beforeEach`/`afterEach`, the seeded single-project config, and a private socket. Use socket `pterm-e2e-vtabs`.

- [ ] **Step 1: Write the spec**

The column starts hidden, so every test opens it first through the View menu. Copy `clickMenuItem` from `tests/e2e/menuColumns.spec.ts`.

Four tests:

```ts
test('opening the column takes the horizontal bar away, and closing it brings it back', async () => {
  // Bar first, column hidden: the default every other spec in this suite runs under.
  await expect(window.getByTestId('tabbar')).toBeVisible()
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabs-panel')).toBeVisible()
  await expect(window.getByTestId('tabbar')).toHaveCount(0)
  // The guarantee that matters: no state leaves the workspace without a tab
  // surface. Collapsing to the strip is the other way back, covered below.
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabbar')).toBeVisible()
})

test('collapsing the column to its strip also brings the bar back', async () => {
  await clickMenuItem('toggle-tabs')
  await expect(window.getByTestId('tabbar')).toHaveCount(0)
  await window.getByTestId('tabs-heading').click()
  await expect(window.getByTestId('tabs-toggle')).toBeVisible()
  await expect(window.getByTestId('tabbar')).toBeVisible()
})

test('a split shows as a child row under its tab', async () => {
  const first = /* the id of the only pane, read from [data-testid^="vtab-"] */ ''
  await window.keyboard.press('Meta+d')
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  // One tab row and one child row, NOT two tab rows: that is the whole point of
  // the column over the bar, which can only draw the two side by side.
  await expect(window.locator('[data-testid^="vtab-"]')).toHaveCount(1)
  await expect(window.locator('[data-testid^="vpane-"]')).toHaveCount(1)
})

test('clicking a child row moves the keyboard to that pane', async () => {
  await window.keyboard.press('Meta+d')
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  const childId = (await window.locator('[data-testid^="vpane-"]').getAttribute('data-testid'))!
    .slice('vpane-'.length)
  await window.getByTestId(`vpane-${childId}`).click()
  // Typed text has to land in the pane that was clicked. Read through the
  // buffer helper, because the WebGL renderer leaves `.xterm-rows` empty.
  await window.keyboard.type('echo vtabs-target')
  await expect
    .poll(async () => (await terminalTexts(window)).filter((text) => text.includes('vtabs-target')).length)
    .toBe(1)
})
```

Fill the `first` placeholder in the third test by reading the attribute the same way the fourth test does. Import `terminalTexts` from `./harness`.

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/e2e/verticalTabs.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 3: Sabotage each test**

| Mutation | Expected red |
|---|---|
| `showsTabBar` returns `true` always | opening the column takes the horizontal bar away |
| `showsTabBar` returns `!hidden.tabs` (ignoring collapsed) | collapsing the column to its strip |
| `tabTree` returns one node per pane with no children | a split shows as a child row |
| child rows call `onSelect` with `node.pane.id` instead of the kid's id | clicking a child row moves the keyboard |

- [ ] **Step 4: Run the specs most at risk, then the whole suite**

```bash
npx playwright test tests/e2e/splits.spec.ts tests/e2e/tabs.spec.ts tests/e2e/menuColumns.spec.ts
npm run typecheck && npm test && npm run e2e
```

Expected: all green. `splits.spec.ts` is the one to watch: it encodes pixel arithmetic across the whole flex row, and it stays green only because this column defaults hidden. If it goes red, the default is wrong, not the arithmetic.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/verticalTabs.spec.ts
git commit -m "Cover the tabs column end to end"
```

---

### Task 7: Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-08-08-vertical-tabs-column-design.md` (a short outcome note)

- [ ] **Step 1: Record what was measured**

Append an "As built" section to the design doc noting: the observed default state, whether `menuColumns.spec.ts` did in fact survive untouched (it was predicted to), whether `splits.spec.ts` stayed green, and the sabotage results from Tasks 1, 3 and 6. Correct any statement in the design that turned out wrong rather than leaving it to be trusted later.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-08-vertical-tabs-column-design.md
git commit -m "Record what the tabs column actually did"
```

---

## Self-Review

**Spec coverage.** Column replaces the bar: Task 3 (`showsTabBar`) and Task 6. Active project only: Task 4 passes `tabEntries`, which is already project-filtered. Seventh column with three states: Tasks 2, 3, 5. Read/select/close rows: Task 4. `tabTree` as a sibling of `groupedTabs`: Task 1. Founding-pane parent and its three cases: Task 1. Testid prefixes: Global Constraints and Task 4. Expected breakages: Task 2 (`columnVisibility.test.ts`), Task 5 (`menuColumns.spec.ts`, predicted to survive), Task 6 (`splits.spec.ts`). Known limitation (unnamed panes) is documented in the design and deliberately not implemented.

**Placeholders.** One remains and is marked: the `first` const in Task 6's third test, with the instruction for filling it from the attribute read shown in the fourth test.

**Type consistency.** `TabTreeNode { pane, children }` is defined in Task 1 and consumed with those exact names in Task 4. `showsTabBar(collapsed, hidden)` is defined in Task 3 and called with that argument order in Task 4's gate and Task 6's sabotage. `COLUMN_IDS` leads with `'tabs'` in Task 2, and Task 5's menu item is placed ahead of `toggle-files` to match.
