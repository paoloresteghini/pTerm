# Tab bar: signalling a split

2026-08-08

## The problem

The tab bar lists **panes**, one entry each. `App.tsx` passes
`tabsOfProject(state, projectId)`, which is a filter over the flat `state.panes`
array (`workspace.ts:135`), and `TabBar.tsx:142` already says so in its own
words: "A tab here is a pane wearing a tab's name."

So splitting a tab adds a pane, and adding a pane adds a row to the bar. The two
panes of a split are linked only by `state.tabs[].layout.kids`, which nothing on
screen reads. On a window showing two panes side by side, the bar shows two
unrelated-looking tabs.

Worse, they need not even be next to each other. `applyTabShape` appends the new
pane to the END of `state.panes` (`workspace.ts:876`), so splitting the first of
three tabs puts its sibling last in the bar. Adjacency today is luck.

## The design

Panes of one split are drawn contiguously and share a 2px accent strip along the
**top** of their combined span, with no divider between them.

```
████████████████████████████████        ← 2px accent strip, the group
 prcli·ce753d ×   prcli·e91c1b ×  │ prcli·95a304 ×
 ▔▔▔▔▔▔▔▔▔▔▔▔▔▔                          ← 1px accent, the active tab
          ↑ no divider inside the group
```

Two signals on two edges. Bottom, saturated: *this pane is focused* — unchanged.
Top, reduced alpha: *these panes are one split*. A group of one draws nothing;
a split is the only thing worth saying.

### Ordering

New pure module, `src/renderer/lib/tabGroups.ts`:

```ts
export interface TabGroupEntry {
  pane: TabDescriptor
  /** The `TabRow.id` this pane belongs to, or null when no row names it. */
  groupId: string | null
  /** Null for a group of one — the caller draws no frame for those. */
  pos: 'first' | 'middle' | 'last' | null
}

export function groupedTabs(panes: TabDescriptor[], rows: TabRow[]): TabGroupEntry[]
```

Walk `panes` in the order given. On reaching the first member of a row that
holds two or more panes, emit every member of that row in `layout.kids` order
and mark them emitted; skip them when the walk reaches them later. A pane in no
row, or in a row of one, emits in place with `groupId` set (or null) and
`pos: null`.

Two properties this buys, and both are the point:

- A group is anchored where its **earliest existing member already sat**. A
  split does not make its tab jump to the end of the bar, and it does not
  reorder anything that is not part of it.
- Members are ordered by `layout.kids`, so left-to-right in the bar matches
  left-to-right on screen for a `row` tab.

`layout.kids` may name a pane that is not in `panes` (a pane of another project,
or one main has dropped). Those are skipped, exactly as `panesOfTab` skips them
(`workspace.ts:286`). A row left with one surviving member is a group of one and
draws no frame.

### One array, two consumers

`App.tsx` calls `groupedTabs` once. `⌥1..9` indexes `currentTabs`
(`App.tsx:1221`) and `TabBar` renders the same list. If `TabBar` sorted
privately, `⌥3` would stop selecting the third visible tab. So:

```ts
const tabEntries = useMemo(
  () => (state.activeProjectId ? groupedTabs(tabsOfProject(state, state.activeProjectId), state.tabs) : []),
  [state],
)
const currentTabs = useMemo(() => tabEntries.map((entry) => entry.pane), [tabEntries])
```

`currentTabs` keeps its existing type and every existing consumer. `TabBar`'s
`tabs` prop changes from `TabDescriptor[]` to `TabGroupEntry[]`.

### Rendering

No new elements. This matters: 27+ e2e locators count tabs by
`[data-testid^="tab-"]`, and a new per-tab element under that prefix inflates
every one of them. The grouping travels on the tab div that is already there:

- `data-group-id={groupId ?? undefined}`
- `data-group-pos={pos ?? undefined}`

The strip is a second inset box-shadow on the same div, composed with the
existing active-tab inset:

```
pos !== null        → inset 0 2px 0 --color-accent at ~40% alpha
active              → inset 0 -1px 0 --color-accent   (unchanged)
```

Adjacent members each paint their own top 2px, so the strip is continuous across
the group without a wrapper element, without a flex nesting change and without a
single pixel of layout movement.

The divider is the existing `border-r border-border`, dropped when
`pos === 'first' || pos === 'middle'` — that is, kept only on the group's last
member and on ungrouped tabs.

`--color-accent` is `#a3e635`. The strip needs a token or an inline
`color-mix`; a new `--color-accent-dim` in `index.css` is the honest home for it
if it gets used twice.

## Testing

`groupedTabs` is pure, so unit tests carry the ordering rule:

- Splitting the first of three tabs pulls the sibling forward, and the third tab
  does not move.
- A three-pane row emits in `layout.kids` order, not `state.panes` order.
- A pane no row names gets `groupId: null`, `pos: null`.
- A row of one gets `pos: null` — no frame.
- A row naming a pane absent from `panes` skips it, and a row left with one
  surviving member is a group of one.

E2E, in the existing splits spec or a sibling: after ⌘D, the two entries carry
the same `data-group-id`, the first is `pos="first"` and the second `pos="last"`,
and the first has no right border.

Every test gets a sabotage check before it counts — delete the rule it claims to
cover and confirm it goes red.

## Not doing

- **Collapsing a split into one tab-bar entry** (`⊞2` badge). `stateOfTab`
  already exists for the dot that would need, and `workspace.ts:215` records
  what it would cost: every tab-bar entry would stand for a tab rather than a
  pane, changing close, rename and dot semantics and the meaning of ~27 e2e
  locators. A separate decision, not this one.
- **Colouring the strip by the pane's own `PaneColor`.** Members of one group
  can hold different colours, and the strip has to be one colour.
- **Persisting the grouped order.** `groupedTabs` is derived on every render
  from state that already exists; nothing new is stored and nothing can go
  stale.
