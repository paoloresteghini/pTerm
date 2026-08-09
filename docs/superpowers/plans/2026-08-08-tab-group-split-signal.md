# Tab Group Split Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tab bar say which of its entries are the panes of one split, by drawing those entries contiguously under a shared accent strip.

**Architecture:** A new pure module orders panes so a split's members sit together and tags each with its group and position in it. `App.tsx` calls it once and feeds the result to both `⌥1..9` and `TabBar`. `TabBar` renders the tag as a second inset box-shadow and a dropped right border on the tab div that already exists.

**Tech Stack:** TypeScript, React 19, Tailwind v4 (tokens in `src/renderer/index.css`), vitest (`environment: 'node'`), Playwright + `_electron.launch()`.

## Global Constraints

- **No new per-tab DOM element and no new `data-testid` beginning `tab-`.** 27+ e2e locators count tabs with `[data-testid^="tab-"]`; a second element per tab under that prefix inflates every one of them. Grouping travels on `data-*` attributes on the existing tab div.
- **No layout change in the tab bar.** The strip is an inset shadow, painted inside the tab's own box. The bar stays `h-8`.
- **Colours come from `@theme` tokens in `src/renderer/index.css`.** No hex literal in a component.
- **Comments state what is true of the code as committed.** Do not write a comment claiming a measurement you did not take, and do not copy a claim from this plan into a source comment without checking it against the code you actually wrote.
- **Every new test gets a sabotage check** before the task is done: break the rule the test claims to cover, confirm that test (and ideally only that test) goes red, restore. Record the mutation and its result in the test file's header.
- Run `npx tsc --noEmit` before every commit.

---

### Task 1: `groupedTabs`, the ordering and tagging rule

**Files:**
- Create: `src/renderer/lib/tabGroups.ts`
- Test: `tests/unit/tabGroups.test.ts`

**Interfaces:**
- Consumes: `TabDescriptor` and `TabRow` from `src/shared/ipc` (both already exported; `TabRow.layout.kids` is `string[]`, `TabRow.id` is the founder pane's id).
- Produces:
  ```ts
  export interface TabGroupEntry {
    pane: TabDescriptor
    groupId: string | null
    pos: 'first' | 'middle' | 'last' | null
  }
  export function groupedTabs(panes: TabDescriptor[], rows: TabRow[]): TabGroupEntry[]
  ```
  Task 2 imports both names from `src/renderer/lib/tabGroups`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/tabGroups.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { TabDescriptor, TabRow } from '../../src/shared/ipc'
import { groupedTabs } from '../../src/renderer/lib/tabGroups'

/**
 * The order the tab bar draws panes in, and which of them it frames together.
 *
 * Pure, and deliberately so: `App.tsx` calls this once and hands the result to
 * both the bar and the `⌥1..9` handler, so the thing being tested here is the
 * single array those two share. A `TabBar` that sorted privately would make
 * `⌥3` select something other than the third tab on screen, and no test in
 * this file could see it — that risk lives in Task 2's wiring, and
 * `tests/e2e/splits.spec.ts` is where it is checked.
 */

/** A pane with only the fields this module reads, plus the ones the type needs. */
const pane = (id: string): TabDescriptor => ({
  id,
  projectSlug: 'proj',
  cwd: '/tmp/proj',
  type: 'shell',
})

/** A row over `kids`, keyed by its founder — `kids[0]`, as main keys them. */
const row = (kids: string[]): TabRow => ({
  id: kids[0] ?? '',
  groupId: kids[0] ?? '',
  activePaneId: kids[0] ?? null,
  layout: { dir: 'row', ratio: kids.map(() => 1 / kids.length), kids },
})

/** Just the ids, in emitted order — what the bar draws left to right. */
const order = (entries: ReturnType<typeof groupedTabs>): string[] =>
  entries.map((entry) => entry.pane.id)

describe('groupedTabs', () => {
  it('leaves ungrouped panes in the order they came in', () => {
    const entries = groupedTabs([pane('a'), pane('b'), pane('c')], [])
    expect(order(entries)).toEqual(['a', 'b', 'c'])
    expect(entries.map((entry) => entry.groupId)).toEqual([null, null, null])
    expect(entries.map((entry) => entry.pos)).toEqual([null, null, null])
  })

  it('pulls a split sibling forward to its founder, leaving the rest in place', () => {
    // What `applyTabShape` actually produces: the new pane is appended to the
    // END of `state.panes` (workspace.ts:876), so splitting the FIRST of three
    // tabs puts its sibling last. This is the case the whole module exists for.
    const entries = groupedTabs(
      [pane('a'), pane('b'), pane('c'), pane('a2')],
      [row(['a', 'a2'])],
    )
    expect(order(entries)).toEqual(['a', 'a2', 'b', 'c'])
    expect(entries.map((entry) => entry.pos)).toEqual(['first', 'last', null, null])
    expect(entries.map((entry) => entry.groupId)).toEqual(['a', 'a', null, null])
  })

  it('emits a three-pane row in kids order, not in panes order', () => {
    // `kids` is the on-screen left-to-right order of a `row` tab; `panes` is
    // the order main happened to append them in. They disagree after a split
    // of anything but the last pane, and the bar has to follow the screen.
    const entries = groupedTabs(
      [pane('x'), pane('y'), pane('z')],
      [row(['z', 'x', 'y'])],
    )
    expect(order(entries)).toEqual(['z', 'x', 'y'])
    expect(entries.map((entry) => entry.pos)).toEqual(['first', 'middle', 'last'])
  })

  it('anchors the group where its earliest member already sat', () => {
    // The founder is `b` but `a2` is not involved; the group must appear at
    // b's position, not jump to the front or to the end.
    const entries = groupedTabs(
      [pane('a'), pane('b'), pane('c'), pane('b2')],
      [row(['b', 'b2'])],
    )
    expect(order(entries)).toEqual(['a', 'b', 'b2', 'c'])
  })

  it('draws no frame for a row holding one pane', () => {
    const entries = groupedTabs([pane('a'), pane('b')], [row(['a'])])
    expect(order(entries)).toEqual(['a', 'b'])
    // The group id is still reported — it is true — but `pos` is null, which
    // is what the renderer keys the strip off.
    expect(entries[0]?.groupId).toBe('a')
    expect(entries[0]?.pos).toBeNull()
  })

  it('skips a kid that is not in panes, and frames nothing when one survives', () => {
    // A row can name a pane this project's list does not hold: another
    // project's, or one main has dropped. `panesOfTab` skips those
    // (workspace.ts:286) and so does this.
    const entries = groupedTabs([pane('a'), pane('b')], [row(['a', 'gone'])])
    expect(order(entries)).toEqual(['a', 'b'])
    expect(entries[0]?.pos).toBeNull()
  })

  it('handles two groups without letting one absorb the other', () => {
    const entries = groupedTabs(
      [pane('a'), pane('b'), pane('a2'), pane('b2')],
      [row(['a', 'a2']), row(['b', 'b2'])],
    )
    expect(order(entries)).toEqual(['a', 'a2', 'b', 'b2'])
    expect(entries.map((entry) => entry.groupId)).toEqual(['a', 'a', 'b', 'b'])
    expect(entries.map((entry) => entry.pos)).toEqual(['first', 'last', 'first', 'last'])
  })

  it('emits every pane exactly once', () => {
    // The guard against the obvious bug in a walk that emits members
    // out-of-turn: a pane emitted with its group AND again at its own turn.
    const panes = [pane('a'), pane('b'), pane('a2'), pane('c')]
    const entries = groupedTabs(panes, [row(['a', 'a2'])])
    expect(entries).toHaveLength(panes.length)
    expect(new Set(order(entries)).size).toBe(panes.length)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/tabGroups.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/renderer/lib/tabGroups"`.

- [ ] **Step 3: Write the module**

Create `src/renderer/lib/tabGroups.ts`:

```ts
import type { TabDescriptor, TabRow } from '../../shared/ipc'

/**
 * The order the tab bar draws panes in, and which of them belong to one split.
 *
 * The bar lists PANES, one entry each — `App.tsx` passes a filter over the flat
 * `state.panes` array (`workspace.ts:135`), and `TabBar.tsx` says the same
 * thing in its own words. So a split adds an entry, and nothing on screen says
 * the new entry and the one it came from are two halves of what the user sees
 * as a single window.
 *
 * They need not even be adjacent: `applyTabShape` appends the new pane to the
 * END of `state.panes` (`workspace.ts:876`), so splitting the first of three
 * tabs puts its sibling last. Adjacency in a running app is luck, which is why
 * this reorders rather than only tagging.
 */
export interface TabGroupEntry {
  pane: TabDescriptor
  /**
   * The `TabRow.id` whose `layout.kids` names this pane, or null when no row
   * does — true of any pane main has not yet filed under a tab, and of every
   * tab opened this run and never split.
   */
  groupId: string | null
  /**
   * Where this pane sits in its group's run of entries, or null when there is
   * no run to sit in: an ungrouped pane, or a row left holding one pane.
   *
   * Null rather than `'first'` for a group of one on purpose. It is what the
   * renderer keys the strip off, and a frame drawn around a single tab would
   * say "this is a split" about something that is not one.
   */
  pos: 'first' | 'middle' | 'last' | null
}

/**
 * Panes reordered so each split's members are contiguous, each tagged with its
 * group and its place in it.
 *
 * The walk goes over `panes` in the order given. Reaching a pane whose row has
 * two or more members PRESENT, it emits that row's members in `layout.kids`
 * order and marks them emitted; reaching an already-emitted pane, it skips.
 * Two properties follow, and both are the point:
 *
 * - a group is anchored where its earliest present member already sat, so a
 *   split does not make its tab jump to the end of the bar and does not move
 *   anything that is not part of it;
 * - members come out in `layout.kids` order, which is on-screen left-to-right
 *   for a `row` tab, so the bar reads the same way round as the window.
 *
 * `kids` may name a pane `panes` does not hold — another project's, or one main
 * has dropped. Those are skipped, exactly as `panesOfTab` skips them
 * (`workspace.ts:286`), and a row left with one present member is a group of
 * one: `groupId` set, `pos` null, no frame.
 */
export function groupedTabs(panes: TabDescriptor[], rows: TabRow[]): TabGroupEntry[] {
  const byId = new Map(panes.map((pane) => [pane.id, pane]))
  const rowOf = new Map<string, TabRow>()
  for (const row of rows) {
    for (const kid of row.layout.kids) rowOf.set(kid, row)
  }

  const emitted = new Set<string>()
  const entries: TabGroupEntry[] = []

  for (const pane of panes) {
    if (emitted.has(pane.id)) continue
    const row = rowOf.get(pane.id)
    // `present` rather than `row.layout.kids`: a kid this list does not hold
    // must not take a slot in the bar, and must not count towards the two that
    // make a group worth framing.
    const present = row
      ? row.layout.kids.map((kid) => byId.get(kid)).filter((kid): kid is TabDescriptor => kid !== undefined)
      : []

    if (present.length > 1 && row) {
      present.forEach((member, index) => {
        emitted.add(member.id)
        entries.push({
          pane: member,
          groupId: row.id,
          pos: index === 0 ? 'first' : index === present.length - 1 ? 'last' : 'middle',
        })
      })
      continue
    }

    emitted.add(pane.id)
    entries.push({ pane, groupId: row?.id ?? null, pos: null })
  }

  return entries
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/tabGroups.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Sabotage-check each test**

For each mutation below, apply it, run `npx vitest run tests/unit/tabGroups.test.ts`, confirm the named test fails, then restore:

1. `present.length > 1` → `present.length > 0`: `draws no frame for a row holding one pane` must fail on `pos` being `'first'`.
2. `row.layout.kids.map(...)` → `panes.filter((p) => row.layout.kids.includes(p.id))`: `emits a three-pane row in kids order` must fail on the order.
3. Delete the `if (emitted.has(pane.id)) continue` line: `emits every pane exactly once` must fail on the length.
4. Drop the `.filter((kid): kid is TabDescriptor => kid !== undefined)` and cast instead: `skips a kid that is not in panes` must fail (an `undefined` member reaches the entry list).

Any mutation that leaves every test green means a test is not covering what it claims. Fix the test before moving on. Add a short "Measured" note to the test file header recording the four mutations and their results.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/renderer/lib/tabGroups.ts tests/unit/tabGroups.test.ts
git commit -m "Put a split's two panes next to each other in the bar's order"
```

---

### Task 2: Draw the group

**Files:**
- Modify: `src/renderer/index.css` (the `@theme` block, around line 18)
- Modify: `src/renderer/TabBar.tsx` (props at 26-44, the tab div at 154-170)
- Modify: `src/renderer/App.tsx` (`currentTabs` at 325, the `TabBar` element at ~1384)

**Interfaces:**
- Consumes: `TabGroupEntry`, `groupedTabs` from `src/renderer/lib/tabGroups` (Task 1).
- Produces: `TabBar`'s `tabs` prop is now `TabGroupEntry[]`. Every tab div carries `data-group-id` (the group's id, absent when `groupId` is null) and `data-group-pos` (`first` | `middle` | `last`, absent when `pos` is null). Task 3 asserts on both.

- [ ] **Step 1: Add the colour token**

In `src/renderer/index.css`, inside the `@theme` block, after `--color-accent`:

```css
  /* The tab bar's split-group strip. `--color-accent` blended 55% over
     `--color-bg` (#09090b), computed rather than picked: (163,230,53) at 0.55
     over (9,9,11) is (94,131,34). Related to the accent by eye, and quiet
     enough that the strip along the top of a group does not compete with the
     saturated accent under the ACTIVE tab — two signals, two edges. Flat and
     opaque rather than an alpha, so it reads the same on `--color-bg` behind an
     active tab and `--color-surface` behind an idle one. */
  --color-group: #5e8322;
```

- [ ] **Step 2: Change TabBar's prop type and the map**

In `src/renderer/TabBar.tsx`:

Add to the imports at the top:

```ts
import type { TabGroupEntry } from './lib/tabGroups'
```

Change the `tabs` prop, in both the destructuring list and the type:

```ts
  tabs: TabGroupEntry[]
```

Change the map's opening line (currently `{tabs.map((tab) => {` at line 116) to:

```tsx
      {tabs.map((entry) => {
        const tab = entry.pane
```

Everything below that line already reads `tab` and does not change.

- [ ] **Step 3: Draw the strip and drop the internal divider**

Still in `src/renderer/TabBar.tsx`, replace the tab div's opening (lines 154-170, the `<div key={tab.id} …>` through its `className`) with:

```tsx
          <div
            key={tab.id}
            data-testid={`tab-${tab.id}`}
            data-active={active ? 'true' : 'false'}
            // The whole grouping signal, carried on the div that is already
            // here. Not a nested element: 27+ e2e locators count tabs with
            // `[data-testid^="tab-"]`, so a second element per tab under that
            // prefix would inflate every one of them.
            data-group-id={entry.groupId ?? undefined}
            data-group-pos={entry.pos ?? undefined}
            onClick={() => onActivate(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault()
              // The tab's own box, so the menu still hangs off this tab's left
              // edge and the bar's bottom the way it looks like it does.
              const box = event.currentTarget.getBoundingClientRect()
              setMenu({ id: tab.id, left: box.left, top: box.bottom })
            }}
            // Two insets on two edges, and they compose rather than replace:
            // the top strip says "these panes are one split" and the bottom
            // line says "this pane is focused", and a grouped active tab shows
            // both. Inline rather than a Tailwind arbitrary value because the
            // list is built from two conditions and an arbitrary value holding
            // a comma is not worth the escaping.
            style={{
              boxShadow:
                [
                  entry.pos === null ? null : 'inset 0 2px 0 var(--color-group)',
                  active ? 'inset 0 -1px 0 var(--color-accent)' : null,
                ]
                  .filter((inset): inset is string => inset !== null)
                  .join(', ') || undefined,
            }}
            className={cn(
              'flex cursor-default items-center gap-1.5 whitespace-nowrap px-2.5',
              // Kept on the group's LAST member and on every ungrouped tab, so
              // the run of a split reads as one box. The strip alone is not
              // enough: a divider through the middle of it says the opposite of
              // what the strip says.
              entry.pos === 'first' || entry.pos === 'middle' ? null : 'border-r border-border',
              active ? 'bg-bg text-fg' : 'text-muted',
            )}
          >
```

Note what moved: `border-r border-border` came out of the first `cn` argument and became conditional, and `shadow-[inset_0_-1px_0_var(--color-accent)]` came out of the active branch and became part of the inline `boxShadow`.

- [ ] **Step 4: Wire the ordering in App.tsx, once**

In `src/renderer/App.tsx`, add to the imports from `./lib/tabGroups`:

```ts
import { groupedTabs } from './lib/tabGroups'
```

Replace line 325:

```ts
  const currentTabs = state.activeProjectId ? tabsOfProject(state, state.activeProjectId) : []
```

with:

```ts
  // Grouped ONCE, here, and read by two consumers: the bar draws it and
  // `⌥1..9` indexes it (see the Digit branch of the keydown handler). A
  // `TabBar` that sorted privately would leave `⌥3` selecting something other
  // than the third tab on screen, and no unit test could see the disagreement.
  const tabEntries = state.activeProjectId
    ? groupedTabs(tabsOfProject(state, state.activeProjectId), state.tabs)
    : []
  const currentTabs = tabEntries.map((entry) => entry.pane)
```

`currentTabs` keeps its `TabDescriptor[]` type, so every existing reader of it is untouched.

Then change the `TabBar` element's `tabs` prop (around line 1384):

```tsx
            tabs={tabEntries}
```

- [ ] **Step 5: Typecheck and run the whole unit suite**

Run: `npx tsc --noEmit && npm test`
Expected: typecheck clean; the unit suite green, including Task 1's file.

If `tsc` reports the `tabEntries` dependency of the keydown `useEffect` — it lists `currentTabs`, which is now a fresh array each render exactly as it was before — leave the dependency list alone. `currentTabs` was already rebuilt on every render by the old line, so nothing about its identity has changed.

- [ ] **Step 6: Look at it**

Run the app (`npm start`), open a project, press ⌘T then ⌘D. Confirm by eye:
- the two entries sit next to each other with no vertical rule between them;
- a green strip runs unbroken along the top of both;
- the active one still has its own brighter line underneath;
- a third, unsplit tab keeps its divider and has no strip.

A test can read the computed style and none can read this. Record what you saw in the commit message if anything differed from the above.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/index.css src/renderer/TabBar.tsx src/renderer/App.tsx
git commit -m "Frame a split's two tabs under one strip, and drop the rule between them"
```

---


### Task 3: The e2e that sees it

**Files:**
- Modify: `tests/e2e/splits.spec.ts` (add one `test(...)`; extend the file header)

**Interfaces:**
- Consumes: `data-group-id` and `data-group-pos` on the tab divs (Task 2); the file's existing `launch()` (line ~220), `paneIds(window)` (line ~247) and `sessionNames` from `./harness`.
- The file is flat `test(...)` calls with a shared `test.beforeEach` / `test.afterEach` that kill the socket and make the temp dirs (lines 401-417). Do NOT add a `describe`, a `try/finally`, or your own `killServer` — `afterEach` already does it. Every test in the file ends with a bare `await app.close()`.
- Do NOT use the file's `splitTabInto(window, count)` helper. It opens the tab itself and asserts `sessionNames(SOCKET).length === 1` immediately after (line 321), so it is only correct as the FIRST tab of a run. This test needs two tabs before the split.

- [ ] **Step 1: Write the failing test**

Add at the end of `tests/e2e/splits.spec.ts`:

```ts
// The bar lists PANES, one entry each, so a split adds an entry that looks
// unrelated to the one it came from — and need not even sit beside it, since
// `applyTabShape` appends the new pane to the END of `state.panes`
// (`workspace.ts:876`).
//
// Which is why this opens TWO tabs and then goes BACK to the first to split
// it. That is the arrangement where `state.panes` is [A, B, A2] and the bar
// must draw A, A2, B: a `groupedTabs` that tagged the panes but never reordered
// them passes every other shape of this test and fails this one.
test('a split names itself in the tab bar, next to the tab it came from', async () => {
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(1)
  const [first] = await paneIds(window)
  expect(first).toBeDefined()

  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(2)
  const [second] = await paneIds(window)
  expect(second).toBeDefined()
  expect(second).not.toBe(first)

  // Back to the first tab, and split THAT one. `paneIds` reads the visible
  // group, so waiting for it to report `first` waits for the activation to
  // reach the DOM rather than assuming the click did it.
  await window.getByTestId(`tab-${first}`).click()
  await expect.poll(async () => paneIds(window)).toEqual([first])

  await window.keyboard.press('Meta+d')
  await expect(
    window.getByTestId('terminal-active').locator(':scope > [data-testid^="pane-"]'),
  ).toHaveCount(2)
  await expect.poll(async () => (await sessionNames(SOCKET)).length, { timeout: 20_000 }).toBe(3)
  const panes = await paneIds(window)
  const sibling = panes.find((id) => id !== first)
  expect(sibling).toBeDefined()

  /**
   * Every tab-bar entry, left to right, with the four things this test reads.
   *
   * `[data-testid^="tab-"]` is the same prefix 27+ locators across the suite
   * count tabs with, and it matches the tab divs only: the bar itself is
   * `tabbar`, and the per-tab `tablabel-`, `tabinput-` and `tabmenu-` testids
   * all lack the hyphen. If this returns more entries than there are tabs,
   * something new has been added under that prefix and the rest of the suite
   * is already miscounting.
   */
  const bar = await window
    .getByTestId('tabbar')
    .locator('[data-testid^="tab-"]')
    .evaluateAll((els) =>
      els.map((el) => ({
        id: (el as HTMLElement).dataset.testid?.replace('tab-', '') ?? '',
        group: (el as HTMLElement).dataset.groupId ?? null,
        pos: (el as HTMLElement).dataset.groupPos ?? null,
        borderRight: getComputedStyle(el).borderRightWidth,
        shadow: getComputedStyle(el).boxShadow,
      })),
    )

  // The reordering. `state.panes` is [first, second, sibling]; the bar is not.
  expect(bar.map((entry) => entry.id)).toEqual([first, sibling, second])

  const [founderRow, siblingRow, loneRow] = bar
  expect(founderRow).toBeDefined()
  expect(siblingRow).toBeDefined()
  expect(loneRow).toBeDefined()

  // One split: same group, and the two ends of it.
  expect(founderRow?.group).not.toBeNull()
  expect(siblingRow?.group).toBe(founderRow?.group)
  expect(founderRow?.pos).toBe('first')
  expect(siblingRow?.pos).toBe('last')

  // The tab that was never split is in no group at all.
  expect(loneRow?.group).toBeNull()
  expect(loneRow?.pos).toBeNull()

  // No rule inside the group, one on the way out of it, one after the tab that
  // is not in it. The strip alone would not be enough: a divider through the
  // middle of a group says the opposite of what the strip says.
  expect(founderRow?.borderRight).toBe('0px')
  expect(siblingRow?.borderRight).not.toBe('0px')
  expect(loneRow?.borderRight).not.toBe('0px')

  // The strip. `--color-group` is #5e8322 = rgb(94, 131, 34). The colour and
  // the `inset` keyword are asserted separately so a change to either names
  // itself rather than failing one opaque string comparison.
  expect(founderRow?.shadow).toContain('rgb(94, 131, 34)')
  expect(founderRow?.shadow).toContain('inset')
  expect(siblingRow?.shadow).toContain('rgb(94, 131, 34)')
  expect(loneRow?.shadow).not.toContain('rgb(94, 131, 34)')

  await app.close()
})
```

- [ ] **Step 2: Get the failure honestly**

The test is being written after Task 2 shipped, so run it against a tree without Task 2 first:

```bash
git stash push src/renderer/TabBar.tsx src/renderer/App.tsx src/renderer/index.css
```

That only works if Task 2 is uncommitted. If it is already committed, use a scratch revert instead:

```bash
git revert --no-commit HEAD && npx playwright test tests/e2e/splits.spec.ts -g "names itself in the tab bar"; git revert --abort || git reset --hard HEAD
```

Expected: FAIL on `expect(bar.map(...)).toEqual([first, sibling, second])` — without the reorder the bar reads `[first, second, sibling]`. Restore the changes before continuing.

- [ ] **Step 3: Run it against the real build**

Run: `npx playwright test tests/e2e/splits.spec.ts -g "names itself in the tab bar"`
Expected: PASS.

If it fails on the `toEqual` with the right ids in the right order but a length of 4+, read the note in the `bar` helper's comment: something has been added under `[data-testid^="tab-"]`.

- [ ] **Step 4: Sabotage-check it**

Each mutation, then run the single test, then restore. Record each result in the header note you write in Step 5:

1. `App.tsx`: pass `tabs={currentTabs.map((pane) => ({ pane, groupId: null, pos: null }))}` instead of `tabEntries`. Both the order assertion and the group assertions must fail.
2. `App.tsx`: keep `groupedTabs` for `TabBar` but give `⌥1..9` the ungrouped list — `const currentTabs = tabsOfProject(...)`. **This test will stay green.** That is the honest result, and it is why Step 5 lists the ⌥ ordering as uncovered rather than claiming it.
3. `TabBar.tsx`: make `border-r border-border` unconditional again. `founderRow.borderRight` must fail.
4. `TabBar.tsx`: drop the `inset 0 2px 0 var(--color-group)` entry from the shadow list. The two strip assertions must fail.
5. `index.css`: change `--color-group` to `#ffffff`. The colour assertions must fail, and nothing else in the file should.

If mutation 1 leaves the test green, the test is reading something the wiring does not produce. Fix it before moving on.

- [ ] **Step 5: Extend the file's header**

`splits.spec.ts` opens with a header stating what the file covers and, separately, what it does NOT see. Both halves need a line, and the second half is the one that matters:

Add to the covered list: one sentence for this test, saying it opens two tabs, splits the first, and reads the bar's order, group attributes, borders and strip colour.

Add to the "What this file does NOT see" list, and write only what stayed true after Step 4's mutations:

- **that the strip is CONTINUOUS across the two entries.** The test reads each tab's own computed shadow. Nothing measures that the two 2px runs meet with no gap, and a change to the bar's spacing or the tabs' padding would break the join without failing anything here. Checked by eye during Task 2 instead.
- **that `⌥1..9` indexes the same order the bar draws.** Grouping happens in `App.tsx` rather than in `TabBar` precisely so those two cannot disagree, and **measured during Step 4, mutation 2**: handing `⌥1..9` the ungrouped list leaves this test green. Nothing in this repo presses ⌥3.

- [ ] **Step 6: Run both suites**

Run: `npm test && npx playwright test`
Expected: unit green; e2e green. Watch `tabs.spec.ts` and `columns.spec.ts` in particular — they hold the `[data-testid^="tab-"]` counts this change was designed not to disturb.

If an e2e file goes red, read the failure before rerunning: a red test re-queues the rest of its file against a fresh app, so one real failure can present as several.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/splits.spec.ts
git commit -m "See the group strip in a real window, and say what it still cannot see"
```

---

## Not in this plan

Stated so they are not mistaken for oversights, and each is in the spec's own "Not doing":

- Collapsing a split into one tab-bar entry with a `⊞n` badge. `stateOfTab` already exists for the dot that would need (`workspace.ts:224`), and `workspace.ts:215` records what the change would cost.
- Colouring the strip from the pane's own `PaneColor`. Members of one group can hold different colours.
- The sidebar's per-project tab list (`tabsOf` at `App.tsx:1327`), which still reads `tabsOfProject` directly and is unordered by this change.
