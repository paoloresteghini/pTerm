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

Named up front so a red run is recognised rather than investigated:

- **`menuColumns.spec.ts`** — a seventh column adds a View-menu item, and that
  spec asserts the menu's contents.
- **`columnVisibility.test.ts`** — enumerates the six ids.
- **`splits.spec.ts`** — only if the column defaults to anything but hidden. It
  encodes pixel arithmetic across the whole flex row, and an always-on column
  breaks five tests at once. The column defaults hidden like every other column,
  which is what keeps the rest of the suite untouched, and that spec gets run to
  confirm rather than assumed.

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
