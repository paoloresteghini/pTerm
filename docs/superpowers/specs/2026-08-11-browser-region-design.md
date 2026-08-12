# Browser region: a second pane area, browser only

**Date:** 2026-08-11
**Status:** design approved, not implemented
**Follows:** `2026-08-11-browser-pane-design.md` (M1, shipped in 0.3.9)

## Problem

M1 made `browser` a third sessionless pane kind. ⌘K "New browser pane" opens one,
and it founds a tab of its own in the terminal column, exactly like `editor` and
`diff` do. That is the complaint: a browser takes over the terminal area instead
of sitting beside it, so the common case (a dev server running in a terminal, its
page open next to it) is impossible without switching tabs back and forth.

Splitting a browser alongside a terminal in one tab is not available: splits and
joins in pTerm are tmux operations and a browser pane has no session, so
`splitPane` / `joinPane` cannot reach it. That route (a sessionless join) was
considered and is not what this design does.

## What this builds

A second pane area, to the right of the terminal column, holding browser panes
only, with its own tab bar.

```
┌────┬──────────────┬──────────────┐
│side│ term tabs    │ browser tabs │
│bar │──────────────│──────────────│
│    │ $ npm run dev│  localhost   │
│    │              │  :5173       │
└────┴──────────────┴──────────────┘
```

Decisions taken during brainstorming:

- **Region beside terminals**, not a pane inside a terminal tab, not a separate
  OS window.
- **Auto-open, manual hide.** The region appears when the first browser pane
  opens and can be collapsed by hand while its browsers stay alive.
- **Tabs only inside the region.** No splits, no stacking, one visible browser at
  a time. This is what keeps the whole feature free of ratio and divider work.
- **Browser kind only.** `editor` and `diff` stay in the terminal column for now.
  The region gates on a kind predicate, so admitting them later is a change to
  that predicate plus tests, not a rework. The reason to hold: browser panes are
  long lived and want to sit beside a terminal, while editor and diff are
  transient and opened from the Files and Git columns, and moving them multiplies
  the e2e blast radius on tests that count tabs.
- **Keys follow focus.** ⌥1-9 (select tab) and ⌘W (close pane) act on whichever
  region has focus.

## Architecture

### State model

No new arrays. Browser panes stay in `state.panes` and `state.tabs`. Region
membership is derived from the pane's kind, never stored:

```ts
export type Region = 'terminal' | 'browser'
export function regionOf(pane: { type: TabType }): Region {
  return pane.type === 'browser' ? 'browser' : 'terminal'
}
```

It lives in `src/shared/ipc.ts` beside `canHaveSession`, and for the reason
that predicate gives for living there: main has the same question to answer
(the activated write-back in `register.ts` picks which field to store by it),
and two spellings of "is this a browser" is how the two sides come to disagree.

A stored `region` field would be a second answer to a question `type` already
answers, free to disagree with it. The predicate above is also the single place
`editor` and `diff` would join later.

Three derivations in `src/renderer/workspace.ts` become region aware:

| Today | After |
| --- | --- |
| `tabsOfProject(state, projectId)` | takes a region, so one pane list yields two tab strips |
| `activeTabId(state)` | takes a region, reading `project.activeTabId` or the new `project.activeBrowserTabId` |
| `paneGroups(state)` | takes a region: filters `state.panes` by it, and picks `visibleGroupId` from that region's active id |

Both regions still mount every pane they own, hidden ones included. The rule that
a terminal is never unmounted (it would dispose its xterm and lose scrollback)
and its webview equivalent (a browser pane would lose its page) are unchanged.

Reducer changes in `workspaceReducer`:

- `opened` and `activatedTab` route to the active-id field that matches the
  pane's kind.
- `closedPane` picks the replacement selection from within the same region.
- One new action, `activatedRegion`, for focus (below).

### Render and column plumbing

`'browser'` joins the `ColumnId` union (`src/shared/ipc.ts`) and
`COLUMN_ORDER_DEFAULT` (`src/renderer/lib/columnOrder.ts`), placed immediately
after `'terminal'`.

Two consequences come free and are worth stating because they remove work:

- `columnIsCollapsed` reads a missing key as collapsed, so every profile written
  before this change starts with the region hidden. No migration.
- `orderFromStored` appends a slot the stored list never mentions, so an upgrade
  gains the column rather than losing the user's order.

The region is `BrowserColumn.tsx`: a `<Panel>` (so it inherits the resizer,
`side={resizerSideFor(order, 'browser')}`) wrapping a tab strip and the region's
`paneGroups` output. Width goes through the existing `columnWidth.ts` keys.
Default width 480px.

The tab strip reuses `TabBar` rather than forking a second bar that can drift
from the first. It gains two props:

- `testIdPrefix`, so browser tabs render as `browsertab-<id>` and not
  `tab-<id>`. This is load bearing: 69 e2e locators across 12 spec files
  (measured 2026-08-11) count terminal
  tabs with `[data-testid^="tab-"]`, and a second bar under that prefix would
  inflate every one of them.
- Capability flags that switch off restart, dismiss and join. A browser pane has
  no session, so it can never die, be restarted, or be joined.

Cross region drops are rejected. The drag-tab-onto-tab handler must no-op when
the dragged tab's kind does not match the target strip's region, because kinds
do not move between regions.

### Visibility

- Opening a pane with `type === 'browser'` unhides the column.
- Closing the project's last browser pane hides it.
- A manual hide sticks until the next browser opens.
- **Visibility is a global column preference; membership is per project.** The
  region draws only when the active project has at least one browser pane, so
  switching to a browserless project draws nothing, leaves no empty box, and
  touches no stored preference.
- Restore honors the stored visibility, so a manual hide survives relaunch.

**Drawing nothing does not mean unmounting (decided 2026-08-11, during Task
8).** Every state that takes the region off screen, a collapse, a hide, and
switching to a project with no browser panes of its own, keeps the panes
mounted and hidden where they stand. The region is only ever unmounted when
there is no browser pane anywhere in the workspace, where there is nothing to
keep alive.

The reason is that `paneGroups(state, 'browser')` spans every project, so the
column holds every browser pane in the app, not the active project's. Rendering
`null` for a browserless project would therefore destroy project A's pages
whenever the user looked at project B, and rebuild them from their saved URLs
on the way back, losing scroll, history and any login. The same panes are
already alive whenever any browser pane is in view, so the choice is not
whether to run them but whether a project switch silently destroys them.

**The cost, stated rather than glossed:** a project with no browser panes of
its own now keeps every other project's webviews alive behind it, with their
timers and sockets running.

One consequence worth writing down, because it is not obvious from the CSS:
`visibility` inherits, but a descendant can override it. The visible pane group
inside the region must NOT set `visibility: visible` of its own, or it re-shows
itself straight through the box that is hiding it. The terminal region's groups
do set it, correctly, because nothing ever hides the box around them.

**A collapse must not unmount the panes (decided 2026-08-11, during Task 7).**
Task 7 shipped the column with a collapsed branch that renders the strip and
nothing else, which destroys every `<webview>`: expanding then reloads each
pane from its saved URL with its scroll position and back history gone, and a
logged-in page may need re-authenticating. That contradicts "collapse it while
the browsers stay alive" above. The rule is the one hidden terminal tabs
already follow: a collapsed column keeps its panes mounted and hides them.
Task 8 owns the change. What a zero-sized or hidden `<webview>` does to the
page inside it is not assumed here; it is to be measured before the approach
is fixed.

**Measured 2026-08-11 (Task 8), reading a live guest through
`webContents.executeJavaScript`.** Four states, one page with a scroll
position and a per-load nonce:

| What was done to the pane's box | What the guest reported |
| --- | --- |
| shrunk to the collapsed strip's width | `innerWidth` 463 to 7, a full reflow; nonce and scroll kept |
| `visibility: hidden`, box size kept | no `resize` at all; `innerWidth`, scroll and nonce all unchanged |
| `position: absolute` off the flow, box width kept | `innerWidth` and scroll unchanged |
| `display: none` | no `resize`; state kept, but the guest holds its last size, and a webview that is `display:none` when it mounts has no size to hold |

So the mechanism is `visibility: hidden` on a box that KEEPS the column's open
width, absolutely positioned so the row still pays only for the 24px strip.
Not `display: none`, and not simply leaving the panes inside a 24px column.

A fifth thing had to be measured because it is not CSS at all: React reconciles
by position, so a `collapsed` branch that returns a DIFFERENT tree unmounts the
`<webview>`s however they are styled. Measured, before `BrowserColumn` became
one tree: a collapse and an expand left the pane on `about:blank`, since
navigation is written through to main rather than back into renderer state, so
the rebuilt pane read the URL the pane record still carried.

### Focus and keys

`activeRegion` lives in `App.tsx` state and is not persisted. It is set on
`focusin` within a region wrapper, and on a tab click or a browser opening. It is
forced back to `'terminal'` whenever the region is hidden or empty.

The bindings, as they actually exist in `App.tsx`'s keydown handler:

| Key | Today | After |
| --- | --- | --- |
| ⌥1-9 | selects the nth entry of `tabEntries` | selects the nth entry of the focused region's strip |
| ⌘W | closes `activePaneId` | closes the focused region's active pane |
| ⌘1-9 | selects the nth project | unchanged |
| ⌘T | opens a terminal | unchanged, always the terminal region |
| ⌘D / ⇧⌘D | splits the active pane | unchanged, and a no-op while the browser region has focus, since the region has no splits |
| ⌘⌥ arrows | moves pane focus inside a tab | unchanged, terminal region only |

**One thing to measure before code depends on it:** a click on page content
inside a `<webview>` does not bubble into the host document. Whether the host
still sees `focusin` on the `<webview>` element itself is unverified. It must be
confirmed by running the app, not by reading the code, because a handler that
compiles and never fires is exactly the defect class M1 shipped and then fixed
(Task 8's popup handler). If `focusin` does not fire, the fallback is the
main-side `webContents` focus events already reachable over the bridge.

## Persistence

One new field, and every place that must name it:

| File | What changes |
| --- | --- |
| `src/shared/ipc.ts` (`ProjectDescriptor`) | add `activeBrowserTabId: string \| null` |
| `src/main/state/store.ts` (`ProjectRecord`) | same field on the record |
| `src/main/state/store.ts` read path | validate and default it, as `activeTabId` is |
| `src/main/projects/projects.ts` | default it to `null` on a new project |
| `src/main/ipc/restore.ts` | resolve it against the project's live browser panes, falling back to the first browser pane, then `null` |
| `src/main/ipc/register.ts` | a new `setActiveBrowser` channel writing the new field |

Column width, visibility and order need no new keys.

**Why a second channel rather than widening `setActive`.** `CHANNELS.setActive`
does two jobs: it persists `ProjectRecord.activeTabId`, and it calls
`onActiveTabChanged`, which is what the status router reads to decide whether a
pane is attended, and therefore whether a notification fires. Routing browser
selections through it would tell the router that no terminal is attended
whenever the user clicks the browser, which would fire notifications for a
terminal sitting in plain sight beside the page. So `setActive` keeps its exact
present meaning (terminal attendance) and the browser region's selection is
persisted by its own channel, which touches config and nothing else.

`describeProjects` in `restore.ts` resolves both fields, and its existing
fallback needs narrowing: `activeTabId` today falls back to `own[0]`, which
after this change could be a browser pane. It must fall back to the project's
first non-browser pane, and `activeBrowserTabId` to its first browser pane.

## Edge cases

- Last browser closed: `activeBrowserTabId` becomes `null` and `activeRegion`
  returns to `'terminal'`.
- Status and dead maps never contain browser panes, so sidebar dots, `needsYou`
  and the tombstone flow are unaffected.
- The command palette's pane list already maps every pane in `state.panes`.
  Choosing a browser from it routes through the same kind aware activation, so it
  works with no palette change.

## Testing

Unit:

- the region filter over `state.panes`
- `activeTabId(state, region)` for both regions, including the null cases
- reducer routing for `opened`, `activatedTab` and `closedPane` per region
- auto-open and auto-hide rules
- `COLUMN_ORDER_DEFAULT` contains `browser`; a stored order written before this
  change gains it on read

E2E:

- ⌘K browser: the region appears right of the terminal column, **and the terminal
  tab count is unchanged**. That second assertion is the one that proves the pane
  left the terminal bar; the first alone would pass with the pane in both places.
- ⌘W with the browser region focused closes the browser tab and leaves terminal
  tabs alone
- hide and show, and the active browser tab, survive a relaunch
- two browsers give two tabs in the strip with one visible

Sabotage checks, run and recorded rather than assumed:

- delete the region filter: the terminal-tab-count test must go red
- delete `testIdPrefix`: the existing terminal tab count locators must go red

## Out of scope

- Splits inside the region (tabs only, by decision above)
- Routing `editor` and `diff` into the region
- Proportional resize between the terminal column and the region (the region is a
  px width column; the terminal column remains the `flex-1` absorber)
- Dragging a tab from one region to the other
