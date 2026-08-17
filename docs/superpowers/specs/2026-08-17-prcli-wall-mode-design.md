# Wall mode: one pinned terminal per project, side by side

2026-08-17

## The problem

pTerm shows one project at a time. The sidebar selects a project, the tab bar
selects a tab in it, and the terminal column draws that tab's panes. Everything
else on screen (Files, Git, Notes, Todos, Issues, Skills, Presets, Prompts) is
scoped to that same project.

Someone running Claude in three projects at once therefore watches three
sessions by cycling the sidebar and holding the other two states in their head.
The status dots and `NeedsYou` exist because of exactly this, and they are a
compression of the thing the user actually wants to see: the pane itself. A dot
says a session is waiting; it does not say what it is waiting for, and answering
that costs a project switch and a switch back.

What is wanted is a view where the main terminal of each of several projects is
on screen together.

## What this is

A second mode for the terminal column. In wall mode the column draws a grid of
cells; each cell belongs to a project and shows one pinned pane of that project.

- **Slot membership is explicit.** A project is added to the wall and stays in
  its slot until removed. Nothing reorders itself while it is being read.
- **One pin per project**, stored on the project, so a relaunch comes back to
  the same wall.
- **Cells are the live panes**, not copies or previews. A cell is typeable the
  moment it is focused.
- **The wall replaces the tab bar while it is on**, and nothing else moves.

Three routes reach it, and no new keystroke is claimed:

| Action | Route |
|---|---|
| Turn the wall on and off | View menu item, and a `Toggle wall` command in the palette |
| Put a project on the wall / take it off | The sidebar row's context menu, beside the existing project items, and an `Add to wall` command in the palette for the active project |
| Choose which pane a slot shows | The caret in the cell header, which opens the pin picker; and `Pin to wall` on a tab's own context menu in normal mode |
| Change the column count | View menu, beside the toggle |

The important property, and the reason this is small: wall mode adds no terminal
lifecycle of its own. Every pane it draws is already mounted.

## The one change: more than one group may be visible

`paneGroups` (`workspace.ts:774`) already returns a group for every tab in the
whole workspace, across every project, and marks exactly one of them visible:

```ts
groups.push({ id, visible: id === visibleGroupId, style, panes })
```

`visibleGroupId` (`workspace.ts:723`) resolves the active project's selection
for the region. `App.tsx:565` calls it once for the terminal region and
`App.tsx:574` again for the browser region, and `App.tsx:2037` maps every group
unconditionally into the DOM. The comment above that map (`App.tsx:2032`) states
the rule:

> Every terminal stays mounted, across every project and every tab: both maps
> below are unconditional, and neither list is filtered down to what is on
> screen. Unmounting would dispose an xterm and lose its scrollback on each
> switch.

Hidden groups are `invisible z-0 pointer-events-none`, not `display: none`, and
deliberately so: `Terminal.tsx:691` skips a fit when `offsetParent` is null, and
a hidden group stays laid out so it can keep measuring itself.

So the wall does not need to mount, re-parent, move or dispose anything. It
needs `visible` to be true for more than one group at a time, and it needs each
visible group to occupy a rect rather than the whole column.

`visibleGroupId` becomes `visibleGroupIds`, returning a `Set<string>`:

```ts
/**
 * Which groups are on screen. One in normal mode; one per filled wall slot in
 * wall mode.
 */
function visibleGroupIds(state: WorkspaceState, region: Region): Set<string>
```

Normal mode returns the one id it resolves today, so the existing behaviour is
the one-element case rather than a branch beside it. Wall mode is terminal-region
only: `paneGroups(state, 'browser')` keeps its single-visible rule, since the
browser column is not what the wall is a mode of.

`showWelcome` at `App.tsx:566` reads `!groups.some((group) => group.visible)`
and needs no change: an empty wall has no visible group, which is the literal
statement of an empty pane area it already tests for.

## Where a cell's rect comes from

Today a group is positioned by one class list at `App.tsx:2064`:

```
absolute inset-0 flex gap-px bg-border bg-clip-content p-2
```

In wall mode `inset-0` is replaced by the slot's rect. The grid is a column
count over the filled slots, so a rect is arithmetic on the slot index and
needs no measurement:

```ts
/** `src/renderer/lib/wallLayout.ts`, pure, unit-testable under `environment: 'node'`. */
export function cellRect(index: number, count: number, columns: number): CSSProperties
```

Expressed as percentage `left`/`top`/`width`/`height` on the existing absolute
box. Two properties this has to keep, both of which the current code gets from
`inset-0` for free:

- **The box must have a real size at all times.** `Terminal.tsx:700` returns
  early on a zero-width or zero-height container, and `Terminal.tsx:711`'s
  `ResizeObserver` re-fits when it stops being zero, so a transient zero is
  survivable but a permanent one is a pane that never fits.
- **Hidden groups keep `inset-0`.** They must stay full-size and laid out for
  the reason the current code says: a hidden group that shrank would be measured
  at its shrunken size the moment anything did fit it.

The pty follows for free. `Terminal.tsx:688`'s `fitToContainer` runs from the
`ResizeObserver` at `Terminal.tsx:711` and calls `window.pterm.resize(tabId,
term.cols, term.rows)`. Positioning a group into a third of the column resizes
its tmux session exactly as dragging a pane divider does. This is the accepted
cost of the mode: toggling the wall on and off reflows what Claude has drawn,
once each way. It is the same reflow a split already causes, and the alternative
(a cell showing a clipped view of a wider pty) loses the right edge of Claude's
prompt box, which is where its answer options are.

## Focus is the active project

A wall slot is a project, so the wall needs no focus concept of its own.
**The focused cell is `state.activeProjectId`.**

This is what makes the rest of the window need no work at all:

| Surface | Why it already follows |
|---|---|
| Files, Git, Notes, Todos, Issues, Skills, Presets, Prompts | All read the active project today. Moving wall focus is `activatedProject`, which is the same dispatch the sidebar makes. |
| Sidebar | Highlights the active project today. That is the focused cell. Adds only a pin marker per project holding a slot. |
| Status bar | Reads the active project's branch today. |
| `⌘1-9` | `App.tsx:1917` dispatches `activatedProject` for the nth project. In wall mode that focuses the slot if the project holds one. No new binding, and no collision with `⌥⌘1-9`, which is `App.tsx:1909`'s per-region tab strip. |
| Leaving the wall | The active project is already the focused cell's, so toggling off lands on that project and its `activeTabId`. The two modes cannot disagree. |

Clicking a cell dispatches `activatedProject` for that cell's project, alongside
the `selectPane` that `App.tsx:2079`'s `onMouseDown` already does. A project on
the wall clicked in the sidebar focuses its cell rather than leaving the mode.

The tab bar is hidden while the wall is on. Its job is choosing among one
project's tabs, and each cell header does that for its own project. `showsTabBar`
(`columnVisibility.ts`) gains the wall flag as a third input, which keeps the
"there is always a tab surface" rule in the one function that states it.

## Pinning

A pin is a pane id on the project.

```ts
// src/main/state/store.ts, ProjectRecord
/**
 * The pane this project shows in wall mode, or null for a slot the user has
 * not filled yet. A pane id, resolved against `panes` at describe time the way
 * `activeTabId` is: a pin can outlive its pane, and a pin naming a pane that is
 * gone reads as an empty slot rather than an error.
 */
wallPin: string | null
/** When true the pin tracks this project's `activeTabId` instead of staying put. */
wallFollowActive: boolean
```

Surfaced on `ProjectDescriptor` (`shared/ipc.ts:747`) the same way, and written
over a new `CHANNELS.setWallPin`, which follows `setActive`'s shape.

`wallFollowActive` is off by default. A slot that quietly changes what it shows
is a slot that cannot be trusted at a glance, which is the whole point of the
view. It is offered because a project being actively driven is the one case
where following is what the user means.

Three states a cell can be in, and each has to be drawn:

- **Filled**: the pinned pane's group, positioned into the cell.
- **Empty**: the project is on the wall with no pin, or its pin names a pane
  that no longer exists. Draws a placeholder that opens the pin picker. Not an
  error: `restoreWorkspace` prunes saved panes that live tmux does not have, so
  a pin surviving its pane is the ordinary outcome of a relaunch after a session
  ended.
- **Dead**: the pinned pane died while the window was up. `paneGroups` boxes a
  dead pane like any other and carries `dead`, so the cell draws the `DeadPane`
  chrome (exit code, Restart, Dismiss) that a normal-view pane draws. The slot
  is not silently reassigned; its scrollback is the record of why it died.

A pinned pane in a split tab brings its whole tab into the cell, because a group
is a tab. That is correct rather than a compromise: the pin names a pane, the
cell shows the tab that holds it, and the pane keeps the accent ring
`App.tsx:2116` already gives the active pane of a multi-pane group.

## Persistence

Two different lifetimes, so two different stores, following the split the
codebase already makes:

- **Pins go in the config** (`store.ts:14`), beside `activeTabId`, because they
  are facts about a project. Adding two fields to `ProjectRecord` bumps
  `PTermConfig.version` from 9 to 10. `store.ts:446` lists the versions read
  without migration; both fields are optional on the way in and default to
  `null` / `false`, so a v9 file reads clean and no migration branch is needed
  beyond widening that list.
- **Slot order, membership and column count go in `localStorage`**, under
  `pterm:wallSlots` and `pterm:wallColumns`, because they are preferences about
  this window's layout. This is where `pterm:columnOrder` and the `*Collapsed`
  keys already live, and `orderFromStored` (`columnOrder.ts`) is the model for
  the reader: anything that is not a clean list of known project ids degrades to
  the default rather than throwing, and an id naming a project that no longer
  exists is dropped rather than drawn.

Slot membership referencing projects by id means a removed project leaves the
wall by itself.

## What this costs

**WebGL contexts.** `claimRenderer` (`Terminal.tsx:151`) budgets live WebGL
contexts under Chromium's per-renderer cap of 16, evicting by least-recently-used
and refusing to take a context from any pane in `onScreen` (`Terminal.tsx:61`).
Wall mode grows `onScreen` from one pane (or one tab's panes) to one per filled
slot. A 2x2 wall of split tabs can exceed the budget, and the existing guard
then leaves the panes past it on the DOM renderer, where Claude's block
characters draw as slivers. This degrades rather than breaks, and it is the
behaviour already specified for a tab holding more panes than the budget, but it
should be measured at 2x2 before shipping rather than discovered.

**The toggle reflows.** Stated above under the cell rect: once each way, by
design.

**Hidden-group fits.** `releaseRenderer` (`Terminal.tsx:116`) documents that a
hidden pane deliberately does not re-fit, so that a background session is not
made to rewrap its scrollback for a width nobody is looking at. Wall mode must
not break that: a group that leaves the wall goes back to `inset-0` and hidden,
and the `visible` effect at `Terminal.tsx:772` handles the claim-then-fit
ordering on the way back in. Nothing here changes that effect.

## What this breaks

- `visibleGroupId` changes signature. Its callers are `paneGroups` and its
  tests.
- `showsTabBar` gains a parameter. Its callers are `App.tsx` and its tests.
- `PaneGroup` gains an optional `rect`, beside `style` rather than inside it:
  `style` stays exactly `{ flexDirection }`, and a group with no rect is a group
  that keeps `inset-0`, which is the statement the renderer needs to read. Test
  literals that build a `PaneGroup` are unaffected, since the field is optional.
- Config v9 to v10. A v10 file read by an older build hits `store.ts:477`'s
  "a version from the future: refuse to guess at its shape", which is the
  intended behaviour and not new.

## Testing

Unit, under `environment: 'node'`, which is where this repo can test logic at
all:

- `wallLayout.cellRect`: rects tile the column with no gap and no overlap, for
  1 to 8 slots at 1 to 4 columns; every rect has non-zero width and height.
- `visibleGroupIds`: one id in normal mode (the existing assertions, rephrased);
  one per filled slot in wall mode; a pin naming a missing pane contributes
  nothing; a pin naming a pane in a split tab contributes that tab's group once.
- Slot storage: `orderFromStored`'s degradation rules, applied to slots (junk,
  duplicates, ids of projects that no longer exist).
- Config: a v9 file reads with `wallPin: null` and `wallFollowActive: false`; a
  round trip preserves a set pin.

End-to-end (`playwright`), which is the only place a real pty and a real fit
exist:

- Three projects with a pinned pane each: all three cells show a live terminal,
  and typing goes to the focused one.
- `⌘2` focuses the second project's cell and the Git column follows it.
- Toggling the wall off lands on the focused cell's project and tab.
- A pinned pane killed outside the app leaves its cell on the `DeadPane` chrome
  with the wall intact around it.
- 2x2 with split tabs: assert how many panes hold a WebGL renderer, so the
  budget question above has an answer recorded rather than assumed.

## Not doing

- **A second window.** It keeps the normal workspace intact on another display,
  which is genuinely better on two monitors, but it means a second renderer
  process, a second copy of the workspace reducer, and a decision about which
  window owns focus, notifications and the dock badge. That is a different and
  much larger piece of work for a variant of this view.
- **A narrow pinned strip beside the full-size terminal.** It fits the column
  system exactly and is the cheapest thing here, but a Claude pane at strip width
  is a status light, not a terminal that can be read or typed into, and reading
  it is the requirement.
- **Auto-populated slots ordered by attention.** Less to manage, but cells would
  reorder themselves under the cursor while being read.
- **Per-cell layouts.** The wall is a grid with a column count. A cell shows a
  tab, and that tab's own splits are the layout inside it.
- **Read-only cells.** A cell is typeable once focused, which is one click or one
  `⌘n` away. Arming a cell before it accepts keys would prevent a stray keystroke
  reaching the wrong project, at the cost of a mode to explain.
