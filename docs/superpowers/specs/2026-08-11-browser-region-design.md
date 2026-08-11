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
