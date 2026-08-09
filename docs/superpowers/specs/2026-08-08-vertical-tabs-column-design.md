# A tabs column, beside the projects list

2026-08-08

## The problem

The tab bar runs out of room. Measured 2026-08-08 while driving the e2e suite:
past roughly fifteen tabs the bar scrolls, and `+` ends up behind it — a
Playwright click on `new-tab` failed with `<div data-testid="tabbar"> intercepts
pointer events`. A user running five clients at once reaches that on an ordinary
day, and the app's own tests cannot drive past it.

The bar also has a shape problem the horizontal axis cannot fix. It lists
**panes**, one row each — `TabBar.tsx:142`, "a tab here is a pane wearing a
tab's name" — so a split adds a row rather than nesting under one.
`0c7b3ec` went as far as a horizontal bar can go: `groupedTabs` reorders panes so
a split's members are contiguous and paints a shared accent strip across them.
That says *these two are one split*. It cannot say *these two belong to that
tab*, because a bar has nowhere to put a child.

A vertical list has both: it scrolls without limit, and it nests.

## What this is

A column between the projects sidebar and the terminal area, listing the active
project's tabs, with each tab's panes as child rows under tree connectors.

```
┌──────────┬────────────────────┬──────────────────────┐
│ Projects │ TABS               │                      │
│          │ ▼ ▣ SS Claude  2h ⚠│                      │
│ ▸ Lumio  │    ├ ▣ SS NPM      │      (terminal)      │
│   Empower│    └ ▣ SS Queue 5m │                      │
│   Hartford ▼ ▣ Sales Claude  ⚠│                      │
│          │    ├ ▣ Sales NPM   │                      │
│          │   ▣ zsh            │                      │
└──────────┴────────────────────┴──────────────────────┘
```

## Decisions

**The column replaces the horizontal bar rather than joining it.** `App.tsx`
renders `<TabBar>` only when the tabs column is not open. Open the column and the
bar goes; collapse or hide it and the bar returns. Drawing the same tab in two
places invites the two to drift, and only replacing the bar actually banks the
overflow fix.

**It shows the active project only.** The projects column sits immediately to its
left and is already the filter. Listing every project's tabs would make that
column decorative and would give a row click the side effect of switching
projects. A cross-project view is a different feature — an attention inbox — and
should be designed as one.

**It is a column, not a setting.** It becomes a seventh `ColumnId` with the
open / collapsed-strip / hidden states shipped in `b22bc57`, so it inherits the
View menu, the persistence and the panel chrome with no second mechanism. This
is what makes the bar rule safe: the states that hide the column are exactly the
states that bring the bar back, so there is no combination in which tabs are
unreachable.

**v1 is read, select and close.** Rows carry the pane's colour, its name, the
status dot and the elapsed label. Clicking a tab row selects it; clicking a child
row moves the keyboard to that pane; a close control removes it. Everything here
already exists in the model.

## Architecture

`src/renderer/TabsPanel.tsx`, a sibling of the six existing panels, following the
`PanelStrip` convention in `Panel.tsx` for its collapsed state.

`'tabs'` joins the `ColumnId` union in `src/shared/ipc.ts` and `COLUMN_IDS` in
`src/renderer/lib/columnVisibility.ts`. Both are single enumerations, so this is
two edits rather than a sweep.

### The row model

A new pure function beside `groupedTabs`, in `src/renderer/lib/tabGroups.ts`:

```ts
tabTree(panes: TabDescriptor[], rows: TabRow[]): TabTreeNode[]
```

Same inputs as `groupedTabs`, same first-wins pane-to-row convention, different
shape: nested rather than flattened. They live in one file precisely so the two
cannot come to disagree about what a group is.

**A node's parent is a real pane, not the row.** `TabRow` has no name of its own
— a title lives on `TabDescriptor.title`, and `renameTab` renames a pane — so a
row cannot label itself. The parent is therefore the tab's **founding pane**, the
one whose id is `TabRow.id`, and the children are the row's remaining kids in
`kids` order. That is also what the screenshot this came from shows: a terminal
with its splits beneath it, not an abstract heading.

```ts
interface TabTreeNode {
  pane: TabDescriptor          // the founding pane, or a pane in no row
  children: TabDescriptor[]    // the row's other kids, in kids order; often empty
}
```

Three cases, all of which the unit tests name:

- a pane belonging to no row → a node with no children
- a row with one kid → a node with no children, so a plain tab looks exactly as
  it does today rather than growing a pointless twist
- a row whose `id` is no longer among its kids — reachable, because the founding
  pane can be closed while its siblings live on → the first kid becomes the
  parent, and the rest are its children

It goes in `tabGroups.ts` rather than reading `paneGroups` from `workspace.ts`:
`paneGroups` computes flex shares, dividers and visibility for the pane area, and
none of that is a list's business.

### Where each part of a row comes from

Nothing here is new state, and there is no new IPC.

| Row part | Source |
|---|---|
| nesting | `tabTree`, over `TabRow.layout.kids` |
| label | `tabLabel(pane)` |
| colour chip | `pane.color` |
| status dot, ⚠ | `state.status[pane.id]`, via `StatusDot` |
| elapsed | `state.since[pane.id]`, via `elapsedLabel` |
| close | `requestClosePane(id)` |

### Interactions

| Action | Handler, all existing |
|---|---|
| click a tab row | `dispatch({ type: 'activatedTab', id })` — what `TabBar` does |
| click a child row | `selectPane(paneId)` — records the pane on its tab, moves focus |
| close | `requestClosePane(id)` — keeps the dirty-editor confirm |
| twist a tab row | local `useState`, not persisted |

## Testing

Two pure units, each with unit tests and each confirmed to go red against a
deliberate mutation:

1. **`showsTabBar(columns)`** in `columnVisibility.ts`. The bar shows iff the tabs
   column is not open. One line, and the guarantee that a tab is always
   reachable — so it is tested directly rather than only through the UI.
2. **`tabTree`** in `tabGroups.ts`. A tab with one pane, a tab with three, a pane
   in no row, two tabs whose panes interleave in `state.panes`, a row whose kid
   is missing from `panes`, and a row whose `id` is no longer among its kids —
   the case that decides which pane becomes the parent. This is where a bug
   would actually hide.

Then `tests/e2e/verticalTabs.spec.ts`: opening the column removes the bar; a
split tab renders child rows; clicking a child moves focus to that pane; close
removes it; collapsing the column brings the bar back.

### Testids

Row testids must avoid three prefixes that are counted elsewhere. `tab-` is
counted by 27+ locators across the suite, `pane-` by `splits.spec.ts`, and
`stab-` belongs to `Sidebar`. This column uses **`vtab-`** and **`vpane-`**.

### What this is expected to break

Named up front so a red run is recognised rather than investigated. Each line
below was checked against the spec file rather than assumed:

- **`columnVisibility.test.ts` WILL break.** Line 28 asserts
  `COLUMN_IDS` equals the exact six-item array, so it fails the moment a seventh
  is added. It is updated as part of the task that adds the id.
- **`menuColumns.spec.ts` should NOT break.** Checked: it clicks menu items by
  id (`toggle-git`, `hide-all-columns`) and asserts specific panels — it never
  enumerates the menu's contents or counts its items, so a seventh entry is
  invisible to it. Its hide-all test still holds, because hiding every column
  hides this one too and simply brings the bar back. Run it to confirm; do not
  "fix" it pre-emptively.
- **`splits.spec.ts`** — at risk only if the column defaults to anything but
  hidden. It encodes pixel arithmetic across the whole flex row, and an
  always-on column breaks five tests at once. The column defaults hidden like
  every other column, which is what keeps the rest of the suite untouched, and
  that spec gets run to confirm rather than assumed.

## Known limitation

`tabLabel` falls back to `` `${projectSlug} · ${id.slice(0, 6)}` ``, so an
unnamed split reads `lumio · a1b2c3` where it wants to read `zsh` or `npm run
dev`. The tab bar has always done this, so the column is no worse — but the
density that makes a vertical list worth having is partly that every row says
something useful. Naming a pane after its running command is the natural
follow-up and is a feature in its own right, not a detail of this one.

## Out of scope

Inline rename, colour swatches, a right-click menu, drag-to-reorder, naming panes
by their command, and any cross-project view.

## As built

All six implementation tasks and the end-to-end coverage task landed
(`367cb3d..56ab4df`). This section records what was actually measured, not what
was expected, and fixes the two places above that turned out incomplete once the
column existed.

**Default state, observed.** The tabs column starts hidden, the same as every
other column: `App.tsx:162` seeds `hiddenColumns.tabs` from `storedCollapsed(HIDDEN_KEYS.tabs, true)`.
`tests/e2e/verticalTabs.spec.ts`'s first test opens it via the `toggle-tabs` menu
item and confirms the bar was there beforehand and returns on close. The
"defaults hidden like every other column" line above held exactly as written.

**The three predictions in "What this is expected to break," checked one by
one, all held:**
- `columnVisibility.test.ts` broke as predicted, on the `COLUMN_IDS` length
  assertion, and was updated in the task that added the seventh id
  (`tests/unit/columnVisibility.test.ts`, Task 2). One loose end this caused:
  the test's title still read "lists the six columns" against a seven-item
  assertion for one task longer than intended, fixed in a follow-up commit
  (`1446c3f`) rather than in the same change that widened the array. Cosmetic,
  but it means "updated as part of the task that adds the id" was true of the
  assertion and one task later of the title.
- `menuColumns.spec.ts` did not break, and was never touched: `git diff --stat
  367cb3d..HEAD` shows no entry for that file anywhere on the branch. It ran
  green (32/32, bundled with `splits.spec.ts` and `tabs.spec.ts`) as part of
  Task 6's at-risk-spec pass.
- `splits.spec.ts` stayed green, all 11 of its tests, in that same Task 6 run,
  confirming the hidden-by-default column left its pixel arithmetic
  undisturbed, exactly as this section predicted.

**Three hand-written unit and e2e tests turned out unable to fail, each caught
only because sabotage was mandatory on every task, not because anyone went
looking for them.** This is a finding about the plan's own test authorship,
stated plainly:
- Task 1, `tabTree`'s "resolves a pane claimed by two rows to the first,
  matching groupedTabs": both candidate rows in the original test named only
  the one contested kid, so first-wins and last-wins produced the same
  `present[0]` fallback and the test passed under either order. Rewritten with
  two rows that overlap on one kid but differ in their other kid, so the
  result now depends on which one wins (commit `e816fc4`).
- Task 3, `showsTabBar`'s "ignores every other column": the original input
  happened to produce the same answer under the correct `collapsed.tabs`
  check and the mutant `anyOpen(collapsed)` check, so the mutation passed
  clean. Rewritten with an input (tabs collapsed, every other column open)
  where the two checks genuinely disagree, `false` versus `true` (commit
  `40c3777`).
- Task 6, the brief's fourth e2e test ("clicking a child row moves the
  keyboard to that pane"): as literally specified it clicked a child pane
  that a preceding ⌘D had already made active, which is both a `selectPane`
  no-op and, per the implementer's own measurement, a real DOM blur to
  `<body>` from clicking a non-focusable row, so the marker landed nowhere
  under correct code either. It could not pass as written, let alone
  distinguish its mutation. Fixed by clicking the tab row first (a real
  transition) before clicking the child, which is what makes the following
  child click a real transition too instead of a no-op (commit `56ab4df`,
  reviewed and confirmed independently in `review-task6-findings.md`).

**Two corrections to this design, found during the Tasks 4-5 review, not
predicted above:**
- The "Row part | Source" table's `close` row said only `requestClosePane(id)`,
  as if every row always offers a close control. The first cut of `TabsPanel`
  did exactly that, unconditionally, which meant closing a dead pane's row
  reached `manager.kill()` on a session that no longer existed and threw. The
  design should have said what `TabBar` already does: a tombstoned pane
  (`canHaveSession(pane) && dead[pane.id] !== undefined`) gets no close
  control at all, the same way `TabBar` swaps in Restart/Dismiss over the pane
  body instead. Fixed in `TabsPanel.tsx` (commit `5b37084`); this column
  offers neither Restart nor Dismiss itself; a dead pane stays manageable
  because those controls are still reachable on the pane body per
  `DeadPane.tsx`'s own docblock.
- The "Three cases" under the row model left out a fourth, added as a guard
  during Task 1's review rather than predicted up front: two rows claiming the
  same kid, which would otherwise emit that pane as two separate top-level
  nodes. `tabRows` (`src/main/state/store.ts`) already dedupes kids across
  rows when loading from disk, so this is unreachable through today's only
  write path, the same as the equivalent guard `groupedTabs` already carried.
  It is cheap insurance, not a bug found in practice, and it is now covered by
  its own test and mutation in `tabGroups.test.ts` (commit `045dc75`).

Everything else in this design, the row model's shape, the interactions table,
the testid prefixes, and the "It shows the active project only" and "It is a
column, not a setting" decisions, matched what shipped with no correction
needed.
