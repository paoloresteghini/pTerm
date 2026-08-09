# Columns you can drag into the order you want

2026-08-09

## The problem

The window is a flex row of nine things, written out by hand in `App.tsx`:

```
Files │ Projects │ Tabs │ TERMINAL │ Skills │ Presets │ Prompts │ Git │ Notes
```

Each is a literal JSX sibling at a fixed place in the source (`FilesPanel` at
1351, `Sidebar` at 1360, `TabsPanel` at 1422, the terminal's flex column at
1436, then the remaining five between 1802 and 1850). The order on screen is
therefore a property of where someone typed them, and it cannot be changed
without editing the file.

A user running five clients wants Git beside the terminal on one machine and
Notes there on another. Today that is a code change.

There is also a smaller problem that this fixes on the way past.
`COLUMN_IDS` in `columnVisibility.ts` carries the comment *"Left to right as
they appear on screen, which is the order the menu lists"* and reads:

```ts
['tabs', 'files', 'skills', 'presets', 'prompts', 'git', 'notes']
```

On screen, Files is left of Tabs. The comment is false. It is false because
the array's order and the JSX's order are two independent facts kept in step
by hand, and nothing fails when they drift. Rendering from the array is what
makes that class of bug impossible rather than merely fixed.

## What this is

A stored left-to-right order for the whole row, and a drag to change it.

- **Any column may go anywhere, including across the terminal.** Notes can sit
  at the far left; Files can sit to the terminal's right.
- **Projects does not move.** It is the only column with no hide flag and no
  collapse flag, and it is what you change context with, so it keeps one fixed
  landmark in the row. Other columns may still be dropped on either side of it.
- **The default order is exactly today's screen**, so nothing moves until the
  user drags something.

## The order is one fact

New pure module, `src/renderer/lib/columnOrder.ts`:

```ts
import type { ColumnId } from '../../shared/ipc'
import type { PanelSide } from '../ui/Panel'

/** Every member of the row, including the two that are not side columns. */
export type ColumnSlot = ColumnId | 'projects' | 'terminal'

export const COLUMN_ORDER_DEFAULT: readonly ColumnSlot[] = [
  'files', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'notes',
]

export function orderFromStored(raw: string | null): ColumnSlot[]
export function moveColumn(order: ColumnSlot[], id: ColumnSlot, toIndex: number): ColumnSlot[]
export function resizerSideFor(order: readonly ColumnSlot[], id: ColumnId): PanelSide
```

`orderFromStored` is total and never throws. This is chrome, and
`widthFromStored` in `columnWidth.ts` already set that precedent: a
hand-edited or half-written entry should cost the user their preference, not
their window. So:

- unparseable JSON, or anything that is not an array of strings, is the default;
- an id the app does not know is dropped;
- an id the stored order is missing is appended in `COLUMN_ORDER_DEFAULT`
  order, which is what makes a profile written before a new column existed
  pick that column up rather than lose it;
- `terminal` and `projects` are forced present exactly once, wherever they
  first appear, so no stored value can produce a window with no terminal in it.

`moveColumn` refuses to move `projects` and returns the order unchanged, so the
rule lives in one testable place rather than only in whether a drag handle was
rendered.

`resizerSideFor` reads the column's index against `terminal`'s: left of it
means the column is pinned to the window's left edge and its handle goes on its
right, and vice versa. This is the whole mechanism that lets a column cross the
terminal, and it needs no new component. `ColumnResizer` already takes
`side: PanelSide` and documents it as *"Which edge of the window the column is
pinned to. The handle goes opposite."* `PanelStrip` takes the same prop for the
collapsed state.

## Rendering from it

`App.tsx`'s nine hand-written siblings collapse into one map over the order,
with a lookup from slot id to the element for that slot. Every hardcoded
`side` is replaced by the derived value, passed down: ten explicit props
across eight files (`FilesPanel` and `TabsPanel` twice each, `Sidebar`,
`SkillsPanel`, `PresetsPanel`, `PromptsPanel`, `GitPanel`, `NotesPanel` once).

The five right-hand panels' collapsed strips pass no `side` at all and take
`PanelStrip`'s `'right'` default, so they need it threaded too. That default
is not cosmetic: `side` picks which border edge the strip draws, so that the
seam faces the terminal from either side, and `PanelStrip`'s own comment
records that the Files strip once shipped with no visible edge at all by
getting this wrong. A right-hand column dragged to the left without its strip
learning about the move reproduces that bug exactly.

This is the bulk of the work and the part worth reviewing carefully: it is a
structural edit to `App.tsx`, at 1907 lines the renderer's largest file by a
factor of three, and the props each panel takes differ, so the lookup is a
switch over the slot rather than a uniform component.

Hidden columns keep their place in the order while absent from the DOM, so
unhiding a column returns it where it was rather than to a default.

## The drag

Grab a column by its heading; a collapsed column drags by its strip, since a
collapsed column still owns a slot in the row. While dragging, a 2px accent
line marks the gap the column would land in.

One trap to design around: the heading and the collapsed strip share a testid
today, and the e2e harness already has a helper that has to disambiguate them.
The drag handle must not make that worse: the drop target is the gap, not the
neighbouring column, so a drag that ends on a heading does not toggle it.

Projects renders no handle, and `moveColumn` refuses it anyway.

## Persistence

`localStorage`, key `pterm:columnOrder`, holding the JSON array. It sits beside
`pterm:*Collapsed` and the stored widths, and for the same reason those live
there: this is a per-screen preference about the monitor in front of you, not
part of the workspace that `config.json` carries across machines.

## What this breaks

`tests/e2e/columns.spec.ts`, `menuColumns.spec.ts` and `splits.spec.ts` locate
columns positionally and encode the flex row's pixel budget. Total row width is
unchanged by a reorder, so this is milder than adding a column was, but
locators that assume a fixed position need to key off the order instead.

## Testing

`columnOrder.ts` is pure, so every rule above is a unit test: a stored order
missing a column appends it; an unknown id is dropped; a duplicated `terminal`
collapses to one; an absent `terminal` is inserted; `moveColumn` refuses
`projects`; `resizerSideFor` flips when a column moves across `terminal`.

Then one e2e: drag Git to the left of the terminal, assert the DOM order
changed, assert its resize handle moved to the other edge, relaunch and assert
the order survived.

Each test gets a sabotage check before it counts. This repo has found four
tests in one branch that could not fail, so a green assertion is not evidence
until the rule it covers has been broken and seen to redden it.

## Not doing

- **Projects as a draggable column.** It has no hide or collapse state, so it
  would be the one draggable column that cannot be put away, and its place is
  the fixed landmark the rest of the row is read against.
- **Ordering the terminal out of the row.** `terminal` is a member of the order
  so columns can cross it; it is never itself removable, and `orderFromStored`
  forces it present.
- **Per-project or per-workspace orders.** Same ruling `columnWidth.ts` made:
  this is a property of the screen, not of the work.
- **Keyboard reordering.** Worth having, but the ⌥/⇧ space is already spent on
  the column toggles, and a drag is the affordance being asked for.
