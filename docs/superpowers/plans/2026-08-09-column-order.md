# Draggable Column Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag the window's columns into any left-to-right order, including across the terminal, and have that order survive a relaunch.

**Architecture:** A pure module owns the order and the two rules derived from it (which edge a column resizes from, and that Projects cannot move). `App.tsx` stops writing its columns as fixed JSX siblings and renders them from that order instead, so the array and the screen cannot disagree. Drag rewrites the array; localStorage remembers it.

**Tech Stack:** TypeScript, React 19, Tailwind v4, vitest (`environment: 'node'`, no DOM), Playwright + `_electron.launch()`.

## Global Constraints

- **No em dashes anywhere**: code, comments, commit messages, test names, docs. Use commas, colons, parentheses or separate sentences. Hyphens in compound words are fine.
- **Comments state what is true of the code as committed.** Do not transcribe a comment from this plan without checking its claim against the tree. Prefer naming a function over citing a line number: line citations on this repo have drifted twice in two days, and one was invalidated by the very commit that added it.
- **Every new test gets a sabotage check** before its task is done: break the rule the test claims to cover, confirm that test goes red, restore. Report the actual result, including any mutation that does NOT redden the test, which means the test is not covering what it claims and must be fixed. Four tests on the previous branch could not fail; this is not a formality.
- `npx tsc --noEmit` clean before every commit.
- Known and unrelated: some `tests/integration/*` files fail nondeterministically with `posix_spawnp failed` or hook timeouts under load. Pre-existing. Do not chase it, do not report it as yours. If a run is dominated by it, say so and move on.
- The default order must reproduce today's screen exactly, so nothing moves until a user drags something.

---

### Task 1: `columnOrder.ts`, the order and the two rules derived from it

**Files:**
- Create: `src/renderer/lib/columnOrder.ts`
- Test: `tests/unit/columnOrder.test.ts`

**Interfaces:**
- Consumes: `ColumnId` from `src/shared/ipc` (already exported: `'files' | 'skills' | 'presets' | 'prompts' | 'notes' | 'git' | 'tabs'`), `PanelSide` from `src/renderer/ui/Panel` (`'left' | 'right'`).
- Produces, imported by Tasks 2 and 3 from `./lib/columnOrder`:
  ```ts
  export type ColumnSlot = ColumnId | 'projects' | 'terminal'
  export const COLUMN_ORDER_DEFAULT: readonly ColumnSlot[]
  export function orderFromStored(raw: string | null): ColumnSlot[]
  export function moveColumn(order: readonly ColumnSlot[], id: ColumnSlot, toIndex: number): ColumnSlot[]
  export function resizerSideFor(order: readonly ColumnSlot[], id: ColumnId): PanelSide
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/columnOrder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  COLUMN_ORDER_DEFAULT,
  moveColumn,
  orderFromStored,
  resizerSideFor,
  type ColumnSlot,
} from '../../src/renderer/lib/columnOrder'

/**
 * The row's left-to-right order, and the two things that follow from it.
 *
 * Pure, because `vitest.config.mts` runs `environment: 'node'` and logic that
 * lives inside a component cannot be unit-tested here at all. The drag that
 * calls `moveColumn` and the render that reads `resizerSideFor` are covered by
 * `tests/e2e/columnOrder.spec.ts`.
 */

describe('COLUMN_ORDER_DEFAULT', () => {
  it('is the row as it stands before anyone drags anything', () => {
    expect(COLUMN_ORDER_DEFAULT).toEqual([
      'files', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'notes',
    ])
  })
})

describe('orderFromStored', () => {
  it('is the default when nothing is stored', () => {
    expect(orderFromStored(null)).toEqual([...COLUMN_ORDER_DEFAULT])
  })

  it('is the default when the entry is not parseable', () => {
    expect(orderFromStored('{oh no')).toEqual([...COLUMN_ORDER_DEFAULT])
  })

  it('is the default when the entry parses to something that is not an array', () => {
    expect(orderFromStored('"notes"')).toEqual([...COLUMN_ORDER_DEFAULT])
    expect(orderFromStored('{"0":"notes"}')).toEqual([...COLUMN_ORDER_DEFAULT])
  })

  it('keeps a stored order the app fully recognises', () => {
    const stored: ColumnSlot[] = [
      'notes', 'files', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git',
    ]
    expect(orderFromStored(JSON.stringify(stored))).toEqual(stored)
  })

  it('drops an id the app does not know', () => {
    const stored = ['files', 'wallpaper', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'notes']
    expect(orderFromStored(JSON.stringify(stored))).not.toContain('wallpaper')
  })

  it('appends a column the stored order never heard of, in default order', () => {
    // The upgrade case: a profile written before a column existed must pick it
    // up rather than lose it. Two missing at once, to pin that they arrive in
    // COLUMN_ORDER_DEFAULT's order and not in some incidental one.
    const stored: ColumnSlot[] = ['notes', 'projects', 'terminal']
    expect(orderFromStored(JSON.stringify(stored))).toEqual([
      'notes', 'projects', 'terminal', 'files', 'tabs', 'skills', 'presets', 'prompts', 'git',
    ])
  })

  it('collapses a duplicated slot to its first appearance', () => {
    const stored = ['terminal', 'files', 'terminal', 'projects', 'tabs', 'skills', 'presets', 'prompts', 'git', 'notes']
    const order = orderFromStored(JSON.stringify(stored))
    expect(order.filter((slot) => slot === 'terminal')).toHaveLength(1)
    expect(order[0]).toBe('terminal')
  })

  it('puts the terminal back when a stored order has none, so no profile yields a window without one', () => {
    const stored: ColumnSlot[] = ['files', 'projects', 'tabs', 'skills', 'presets', 'prompts', 'git', 'notes']
    expect(orderFromStored(JSON.stringify(stored))).toContain('terminal')
  })

  it('puts projects back when a stored order has none', () => {
    const stored: ColumnSlot[] = ['files', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'notes']
    expect(orderFromStored(JSON.stringify(stored))).toContain('projects')
  })
})

describe('moveColumn', () => {
  it('moves a column to the index asked for', () => {
    const order: ColumnSlot[] = ['files', 'projects', 'tabs', 'terminal', 'notes']
    expect(moveColumn(order, 'notes', 0)).toEqual(['notes', 'files', 'projects', 'tabs', 'terminal'])
  })

  it('moves a column across the terminal', () => {
    const order: ColumnSlot[] = ['files', 'projects', 'tabs', 'terminal', 'notes']
    expect(moveColumn(order, 'notes', 2)).toEqual(['files', 'projects', 'notes', 'tabs', 'terminal'])
  })

  it('refuses to move projects, and hands back the order it was given', () => {
    const order: ColumnSlot[] = ['files', 'projects', 'tabs', 'terminal', 'notes']
    expect(moveColumn(order, 'projects', 4)).toEqual(order)
  })

  it('is a no-op for a slot the order does not hold', () => {
    const order: ColumnSlot[] = ['files', 'projects', 'terminal']
    expect(moveColumn(order, 'notes', 0)).toEqual(order)
  })

  it('does not mutate the array it was given', () => {
    const order: ColumnSlot[] = ['files', 'projects', 'tabs', 'terminal', 'notes']
    const before = [...order]
    moveColumn(order, 'notes', 0)
    expect(order).toEqual(before)
  })
})

describe('resizerSideFor', () => {
  it('says left for a column left of the terminal, so its handle goes on its right', () => {
    expect(resizerSideFor(COLUMN_ORDER_DEFAULT, 'files')).toBe('left')
    expect(resizerSideFor(COLUMN_ORDER_DEFAULT, 'tabs')).toBe('left')
  })

  it('says right for a column right of the terminal', () => {
    expect(resizerSideFor(COLUMN_ORDER_DEFAULT, 'notes')).toBe('right')
    expect(resizerSideFor(COLUMN_ORDER_DEFAULT, 'skills')).toBe('right')
  })

  it('flips when a column is moved across the terminal', () => {
    // The whole reason this function exists: crossing the terminal has to move
    // the grab handle to the column's other edge, or the user drags a strip
    // that is no longer against the terminal.
    const moved = moveColumn(COLUMN_ORDER_DEFAULT, 'notes', 0)
    expect(resizerSideFor(COLUMN_ORDER_DEFAULT, 'notes')).toBe('right')
    expect(resizerSideFor(moved, 'notes')).toBe('left')
  })

  it('says right for a column the order does not hold, rather than throwing', () => {
    expect(resizerSideFor(['projects', 'terminal'], 'notes')).toBe('right')
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/columnOrder.test.ts`
Expected: FAIL, `Failed to resolve import ".../columnOrder"`.

- [ ] **Step 3: Write the module**

Create `src/renderer/lib/columnOrder.ts`. Write the doc comments in your own words after reading `src/renderer/lib/columnVisibility.ts` and `columnWidth.ts` for the house voice: they explain why a thing exists and what it protects against, not what the code says. The behaviour required:

```ts
import type { ColumnId } from '../../shared/ipc'
import type { PanelSide } from '../ui/Panel'

export type ColumnSlot = ColumnId | 'projects' | 'terminal'

export const COLUMN_ORDER_DEFAULT: readonly ColumnSlot[] = [
  'files', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'notes',
]

export function orderFromStored(raw: string | null): ColumnSlot[] {
  if (raw === null) return [...COLUMN_ORDER_DEFAULT]
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [...COLUMN_ORDER_DEFAULT]
  }
  if (!Array.isArray(parsed)) return [...COLUMN_ORDER_DEFAULT]

  const known = new Set<string>(COLUMN_ORDER_DEFAULT)
  const seen = new Set<ColumnSlot>()
  const order: ColumnSlot[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !known.has(entry)) continue
    const slot = entry as ColumnSlot
    if (seen.has(slot)) continue
    seen.add(slot)
    order.push(slot)
  }
  for (const slot of COLUMN_ORDER_DEFAULT) {
    if (!seen.has(slot)) order.push(slot)
  }
  return order
}

export function moveColumn(
  order: readonly ColumnSlot[],
  id: ColumnSlot,
  toIndex: number,
): ColumnSlot[] {
  if (id === 'projects') return [...order]
  const from = order.indexOf(id)
  if (from === -1) return [...order]
  const next = [...order]
  next.splice(from, 1)
  const bounded = Math.max(0, Math.min(next.length, toIndex))
  next.splice(bounded, 0, id)
  return next
}

export function resizerSideFor(order: readonly ColumnSlot[], id: ColumnId): PanelSide {
  const terminal = order.indexOf('terminal')
  const column = order.indexOf(id)
  if (terminal === -1 || column === -1) return 'right'
  return column < terminal ? 'left' : 'right'
}
```

Two decisions to record in the comments, in your own words:

- **`moveColumn` refuses `projects` but not `terminal`.** Refusing projects is the spec's rule and needs to live somewhere testable rather than only in whether a handle was rendered. The terminal is not refused because it never has a handle to drag, so a rule forbidding it would have no caller and no test that could reach it honestly.
- **Everything unrecognised degrades rather than throws**, following `widthFromStored` in `columnWidth.ts`: a bad entry should cost the user their preference, not their window.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/columnOrder.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Sabotage-check**

Apply each mutation, run the file, confirm the named test reddens, restore:

1. `if (id === 'projects') return [...order]` deleted: "refuses to move projects" must fail.
2. The append loop (`for (const slot of COLUMN_ORDER_DEFAULT) ...`) deleted: "appends a column the stored order never heard of" and both "puts X back" tests must fail.
3. `if (seen.has(slot)) continue` deleted: "collapses a duplicated slot" must fail.
4. `return column < terminal ? 'left' : 'right'` changed to always `'right'`: "says left for a column left of the terminal" and "flips when a column is moved across" must fail.
5. `!known.has(entry)` dropped: "drops an id the app does not know" must fail.

Record every result, including any mutation that leaves the suite green. Add the results as a short measured note in the test file's header.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/renderer/lib/columnOrder.ts tests/unit/columnOrder.test.ts
git commit -m "Make the row's order a value, not the order someone typed the JSX in"
```

---

### Task 2: Render the row from the order

**Files:**
- Modify: `src/renderer/App.tsx` (the flex row opening at 1348 through the last column at ~1855)
- Modify: `src/renderer/FilesPanel.tsx`, `Sidebar.tsx`, `TabsPanel.tsx`, `SkillsPanel.tsx`, `PresetsPanel.tsx`, `PromptsPanel.tsx`, `GitPanel.tsx`, `NotesPanel.tsx`

**Interfaces:**
- Consumes: `COLUMN_ORDER_DEFAULT`, `resizerSideFor`, `type ColumnSlot` from `./lib/columnOrder` (Task 1).
- Produces: each side panel takes a required `side: PanelSide` prop and passes it to BOTH its `ColumnResizer` and its `PanelStrip`. Task 3 relies on the row rendering from an array it can reorder.

**This task changes no behaviour.** The order used is `COLUMN_ORDER_DEFAULT`, which is today's screen, so every existing e2e must still pass unchanged. That is the task's own test: it is a structural refactor, and the suite is the oracle.

- [ ] **Step 1: Thread `side` through the eight panels**

Each panel currently hardcodes its side. There are ten explicit props today (`FilesPanel` and `TabsPanel` have two each, one on the strip and one on the resizer; the other six files have one each), and the five right-hand panels' `PanelStrip` calls pass nothing and rely on `PanelStrip`'s `side = 'right'` default.

For each of the eight files: add `side` to the component's props type and destructuring, replace the hardcoded `side="left"` / `side="right"` on its `ColumnResizer` with `side={side}`, and pass `side={side}` to its `PanelStrip` (adding the prop where it is currently absent).

Do not skip the strips. `PanelStrip`'s `side` picks which border edge it draws so the seam faces the terminal from either side, and its own comment records that the Files strip once shipped with no visible edge by getting this wrong. A right-hand column moved to the left with a `'right'` strip reproduces that bug.

`Sidebar` is Projects: it never moves and is always left of the terminal, so pass it `side="left"` from `App.tsx` rather than deriving it. Keeping it a literal is honest about a value that cannot vary.

- [ ] **Step 2: Extract the terminal column**

In `App.tsx`, the terminal is the `<div className="flex min-w-0 flex-1 flex-col">` opening at 1436 and closing before the Skills column. Hoist it, unchanged, into a `const terminalColumn = (...)` above the return. Move the JSX verbatim: this step is a cut and paste, and any edit to its contents belongs to a different task.

- [ ] **Step 3: Render from the order**

Replace the nine hand-written siblings inside `<div className="flex min-h-0 flex-1">` with a map. Write a `renderSlot` helper above the return:

```tsx
const columnOrder: readonly ColumnSlot[] = COLUMN_ORDER_DEFAULT

const renderSlot = (slot: ColumnSlot): ReactNode => {
  switch (slot) {
    case 'terminal':
      return terminalColumn
    case 'projects':
      return <Sidebar side="left" {...} />
    case 'files':
      return hiddenColumns.files ? null : <FilesPanel side={resizerSideFor(columnOrder, 'files')} {...} />
    // one case per remaining column, each keeping its existing props verbatim
  }
}
```

and render:

```tsx
<div className="flex min-h-0 flex-1">
  {columnOrder.map((slot) => (
    <Fragment key={slot}>{renderSlot(slot)}</Fragment>
  ))}
  <CommandPalette {...} />
  {/* everything else that was after the columns stays where it is */}
</div>
```

Every panel keeps the exact props it has today. The only additions are `side` and the move into a case. `Fragment` needs importing from `react` if it is not already.

A `switch` over `ColumnSlot` with no `default` gives you exhaustiveness from `tsc`: a new slot added later fails to compile until it has a case, which is the property that makes this refactor worth doing rather than merely tidy.

- [ ] **Step 4: Typecheck and run the full unit suite**

Run: `npx tsc --noEmit && npm test`
Expected: typecheck clean. Unit suite green.

- [ ] **Step 5: Run every e2e that touches chrome**

Run: `npx playwright test tests/e2e/columns.spec.ts tests/e2e/menuColumns.spec.ts tests/e2e/splits.spec.ts tests/e2e/verticalTabs.spec.ts`
Expected: all green, unchanged. These are the specs that locate columns, drive the resizers, and encode the flex row's pixel budget.

If any fails, the refactor changed behaviour. Find out what rather than adjusting the test: this task's whole claim is that it changed nothing.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx src/renderer/*Panel.tsx src/renderer/Sidebar.tsx
git commit -m "Draw the columns from the order array instead of the order they were typed in"
```

---

### Task 3: Drag to reorder, and remember it

**Files:**
- Modify: `src/renderer/ui/Panel.tsx` (`PanelHeading`, `PanelStrip`)
- Modify: `src/renderer/App.tsx`
- Modify: the eight panel files, to pass the drag props through

**Interfaces:**
- Consumes: `moveColumn`, `orderFromStored`, `COLUMN_ORDER_DEFAULT` from `./lib/columnOrder`.
- Produces: `data-column-slot` on each rendered column's outer element, and `data-drop-index` on each drop gap. Task 4 asserts on both.

- [ ] **Step 1: Give the heading and the strip a drag handle**

`PanelHeading` takes `testid`, `label`, `onClick`. `PanelStrip` takes `testid`, `label`, `side`, `onClick`. Add to both an optional `onDragStart?: () => void`, set `draggable` when it is present, and call it from `onDragStart`.

The click must survive: a drag that starts and ends in place still fires `click` in Chromium, and the heading's click is what collapses the column. Keep `onClick` exactly as it is and let the drop target, not the heading, decide whether a reorder happened.

- [ ] **Step 2: Hold the order in App, restored and persisted**

In `App.tsx`, beside the existing `pterm:*Collapsed` keys:

```ts
const ORDER_KEY = 'pterm:columnOrder'
```

```ts
const [columnOrder, setColumnOrder] = useState<ColumnSlot[]>(() =>
  orderFromStored(localStorage.getItem(ORDER_KEY)),
)

const moveColumnTo = useCallback((id: ColumnSlot, toIndex: number) => {
  setColumnOrder((was) => {
    const next = moveColumn(was, id, toIndex)
    localStorage.setItem(ORDER_KEY, JSON.stringify(next))
    return next
  })
}, [])
```

Replace Task 2's `const columnOrder = COLUMN_ORDER_DEFAULT` with this state. `resizerSideFor(columnOrder, id)` now varies at runtime, which is what makes a column that crosses the terminal move its handle.

- [ ] **Step 3: Drop gaps**

Render a drop target between slots and at both ends. While a drag is in progress, each gap accepts the drop and paints a 2px accent line when hovered:

```tsx
const [dragging, setDragging] = useState<ColumnSlot | null>(null)
const [over, setOver] = useState<number | null>(null)
```

```tsx
const gap = (index: number) =>
  dragging === null ? null : (
    <div
      data-testid={`column-gap-${index}`}
      data-drop-index={index}
      onDragOver={(event) => {
        event.preventDefault()
        setOver(index)
      }}
      onDragLeave={() => setOver((was) => (was === index ? null : was))}
      onDrop={(event) => {
        event.preventDefault()
        if (dragging !== null) moveColumnTo(dragging, index)
        setDragging(null)
        setOver(null)
      }}
      className={cn('w-1 shrink-0', over === index && 'bg-accent')}
    />
  )
```

The gaps exist only during a drag, so they take no width and catch no pointer events the rest of the time. End the drag on `dragEnd` as well as on `drop`, or a drag released outside any gap leaves `dragging` set and the gaps on screen forever.

Give each column's outer element `data-column-slot={slot}` so a test can read the row's order without depending on testid naming per panel.

- [ ] **Step 4: Wire the handles**

Pass `onDragStart={() => setDragging(slot)}` down to each panel, which passes it to its `PanelHeading` and `PanelStrip`. Projects gets none: `Sidebar` is not draggable, and `moveColumn` refuses it regardless, so the rule holds even if a handle is added later by mistake.

- [ ] **Step 5: Typecheck, unit suite, and look at it**

Run: `npx tsc --noEmit && npm test`

Then open the app and drag something. A test can read the DOM order and none can tell you whether the gesture feels like anything:
- drag Git to the left of the terminal, confirm it lands there and its resize handle is now on its left edge;
- drag a collapsed column by its strip;
- confirm the drop line appears in the gap you are over and not elsewhere;
- confirm a click on a heading still collapses it, since that is the gesture most at risk from making the element draggable.

Report what you saw. If you cannot open the app, say so plainly rather than skipping the step silently.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ui/Panel.tsx src/renderer/App.tsx src/renderer/*Panel.tsx src/renderer/Sidebar.tsx
git commit -m "Drag a column into the place you want it, and keep it there"
```

---

### Task 4: The e2e

**Files:**
- Create: `tests/e2e/columnOrder.spec.ts`

**Interfaces:**
- Consumes: `data-column-slot` on each column, `data-testid="column-gap-<n>"` on the drop gaps, `resize-<id>` testids on the resizers (already used by `columns.spec.ts`), and the harness's `launchApp` / `killServer`.

- [ ] **Step 1: Read the neighbours first**

Open `tests/e2e/columns.spec.ts` and copy its shape: its socket constant, its `beforeEach`/`afterEach`, its project seeding, and its `dragHandle` helper, which already drives a pointer across a resizer. Do not invent a second way of doing any of those. Use a socket name of your own so a parallel run cannot collide.

- [ ] **Step 2: Write the failing test**

Three assertions, in one test since they share an expensive launch:

1. **The order changes.** Open two columns, drag one across the terminal into a gap, and read `[...document.querySelectorAll('[data-column-slot]')].map(el => el.dataset.columnSlot)`. Assert the dragged column is now on the other side of `terminal`.
2. **The handle follows it.** Assert the moved column's `resize-<id>` element sits on the opposite edge of that column's box from where it was, by comparing the resizer's `boundingBox().x` against the column's own box before and after.
3. **It survives a relaunch.** Close the app, launch again against the same `userDataDir`, and assert the order read back matches.

Playwright's `dragTo` does not fire HTML5 drag events in every case; if `dragTo` does not work here, dispatch `dragstart` / `dragover` / `drop` explicitly with a `DataTransfer`. Say in the test's comment which one you used and why, because the next person will hit the same fork.

- [ ] **Step 3: Get the failure honestly**

Run the test against the current build first and watch it fail on assertion 1.

Do NOT use `git stash` or `git revert`: other sessions share this checkout, and a rebase here has destroyed uncommitted work twice. To sabotage, edit the working tree and `git checkout -- <file>` afterwards.

- [ ] **Step 4: Sabotage-check**

1. In `App.tsx`, make `moveColumnTo` a no-op: assertion 1 must fail.
2. Replace `resizerSideFor(columnOrder, id)` with a literal `'right'` for the column you move: assertion 2 must fail.
3. Remove the `localStorage.setItem(ORDER_KEY, ...)`: assertion 3 must fail, and 1 and 2 must still pass.

If any mutation leaves the test green, that assertion is not testing what it claims. Fix it before finishing.

- [ ] **Step 5: Full gates**

Run: `npx tsc --noEmit && npm test && npx playwright test`
Expected: typecheck clean, unit green, e2e green with one more test than before.

A red e2e re-queues the rest of its file against a fresh app, so one real failure can present as several. Read the first failure before rerunning. Integration `posix_spawnp` noise is pre-existing and not yours.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/columnOrder.spec.ts
git commit -m "Drive a real column across the terminal and back after a relaunch"
```

---

## Not in this plan

- Keyboard reordering. The modifier space is spent on the column toggles, and a drag is what was asked for.
- Per-project or per-workspace orders. `columnWidth.ts` already ruled this class of preference per-screen.
- Making Projects draggable, or removing the terminal from the row.
- Fixing `COLUMN_IDS`' false "left to right as they appear on screen" comment in `columnVisibility.ts`. Task 2 makes the claim true by construction for the rendered row, but `COLUMN_IDS` itself keeps its own order, which the View menu lists. If that comment should now say something different, it is a one-line follow-up and belongs to whoever next touches that file.
