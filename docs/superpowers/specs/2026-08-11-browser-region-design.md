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

### Render and column plumbing

`'browser'` joins the `ColumnId` union (`src/shared/ipc.ts`) and
`COLUMN_ORDER_DEFAULT` (`src/renderer/lib/columnOrder.ts`), placed immediately
after `'terminal'`.

What an existing profile does on upgrade (both corrected 2026-08-12, during the
final fix wave, where the shipped code disagreed with what this section
originally claimed):

- The stored flag defaults SHOWN, not hidden: `App.tsx` reads it as
  `storedCollapsed(HIDDEN_KEYS.browser, false)`, alone among the columns. That
  is deliberate, and the per-project draw gate is what makes it safe: a profile
  with no browser panes still sees nothing. Defaulting hidden would strand a
  profile that already has browser panes, since this column has no menu item
  and no shortcut with which to bring it back. (`columnIsCollapsed`, which does
  read a missing key as collapsed, has nothing to do with it: it is applied to
  the `columnsVisible` IPC payload in `src/main/index.ts` and never to
  localStorage.)
- `orderFromStored` inserts a slot the stored list never mentions immediately
  right of whichever default-order slot precedes it, rather than appending it.
  Appending was a fallback rather than a decision, and it would have given the
  browser column the far right of the row, past notes and todos, on every
  profile that had ever dragged a column: only a profile that stored no order
  at all would have got it beside the terminal. The rule changed for every
  slot, not for this one: an old profile that never saw `todos` now gains it at
  its default position too.

The region is `BrowserColumn.tsx`: a `<Panel>` (so it inherits the resizer,
`side={resizerSideFor(order, 'browser')}`) wrapping a tab strip and the region's
`paneGroups` output. Width goes through the existing `columnWidth.ts` keys.
Default width 480px.

The tab strip reuses `TabBar` rather than forking a second bar that can drift
from the first. It gains two props:

- `testIdPrefix`, so browser tabs render as `browsertab-<id>` and not
  `tab-<id>`. This is load bearing: the e2e suite counts terminal tabs with
  `[data-testid^="tab-"]` in dozens of places, and a second bar under that
  prefix would inflate every one of them. No number is written here on purpose,
  the same decision `TabBar.tsx` records at the prop itself: the count this
  paragraph used to carry was falsified by the commit that added the second
  bar, whose own spec file uses the locator too. Count them when you need to,
  with `grep -rn 'data-testid\^="tab-"' tests/e2e/ | wc -l`.
- Capability flags that switch off restart, dismiss and join. A browser pane has
  no session, so it can never die, be restarted, or be joined.

Cross region drops are rejected. The drag-tab-onto-tab handler must no-op when
the dragged tab's kind does not match the target strip's region, because kinds
do not move between regions.

### Visibility

- Opening a pane with `type === 'browser'` unhides the column.
- Closing the last browser pane hides it. **The last one in the WORKSPACE, not
  in the project (corrected 2026-08-11, during Task 8).** The stored flag is
  one global preference, so a rule that writes it from one project's count is
  wrong for every other project: measured, opening and closing a browser in
  project B hid a column project A still had a pane for, with no menu item or
  shortcut to bring it back. Closing a project's last browser pane still takes
  the column off screen for that project, but that is the per-project draw
  gate below, and it writes nothing down.
- A manual hide sticks until the next browser opens.
- **Visibility is a global column preference; membership is per project.** The
  region draws only when the active project has at least one browser pane, so
  switching to a browserless project draws nothing, leaves no empty box, and
  touches no stored preference.
- Restore honors the stored visibility, so a manual hide survives relaunch.
- **The column is a full member of `COLUMN_IDS`, and that is the only route a
  user has to hiding it by hand.** It has no View menu item and no shortcut of
  its own, so hide-all (⌘⇧\) and its second press are what hide and show it.
  Membership is also why `src/main/index.ts` maps it to a `toggle-browser` menu
  id that does not exist: `getMenuItemById` returns null and the guard there
  absorbs it, but the same loop folds every member into whether ANYTHING is
  open, and the hide-all item's label has to answer for this column too.
- **Hide-all writes the STORED flag, never the on-screen answer (fixed
  2026-08-12).** The two differ for this column alone: `onScreenColumns.browser`
  is the stored hide OR the active project having no browser pane. That derived
  value decides the item's direction and its label, but writing it back would
  store a hide nobody asked for, for every project, the moment hide-all was
  pressed while looking at a browserless project, with no menu item and no
  shortcut to undo it and nothing but opening a new browser pane to clear it.
  Remembering off the stored flag is the same rule's other half: a hide taken
  from a browserless project has to come back on the second press.

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

`activeRegion` lives in `App.tsx` state and is not persisted. It is set from a
`pointerdown` capture listener reading the event's target, from `focusin` for
the routes that have no pointer event, and explicitly on a tab click, a browser
opening, and a palette selection. It is forced back to `'terminal'` whenever the
region is hidden or empty. See the measurement below for why the event target
rather than the focused element.

The bindings, as they actually exist in `App.tsx`'s keydown handler:

| Key | Today | After |
| --- | --- | --- |
| ⌥1-9 | selects the nth entry of `tabEntries` | selects the nth entry of the focused region's strip |
| ⌘W | closes `activePaneId` | closes the focused region's active pane |
| ⌘1-9 | selects the nth project | unchanged |
| ⌘T | opens a terminal | unchanged, always the terminal region |
| ⌘D / ⇧⌘D | splits the active pane | unchanged, and a no-op while the browser region has focus, since the region has no splits |
| ⌘⌥ arrows | moves pane focus inside a tab | unchanged, terminal region only |

**⌘W does not reach the app from inside a focused page (accepted 2026-08-12).**
While the guest holds focus, the page owns the keyboard and the host never
receives the keystroke at all, so the close binding works from the column's own
chrome (its tab strip, its URL bar) and does nothing while the caret is in the
page. Measured during Task 9, not inferred. The user accepted this rather than
routing ⌘W through a main-process accelerator: an accelerator fires whichever
webview holds focus, but this repo has measured that Playwright cannot test
Electron accelerators, so that route would ship covered by a hand-run alone,
and it would take ⌘W away from any page that uses it. Clicking the column's tab
strip returns the keys.

**The open question above was measured in Task 9, and both answers were no.**
A click on page content inside a `<webview>` fires no `focusin` on the host, and
no `mousedown`, `pointerdown` or `click` either. The fallback this spec
sanctioned, main-side `webContents` focus events bridged to the renderer, does
not fire either: the guest's `WebContents` emitted neither `focus` nor `blur`
across six alternating clicks, and `guest.isFocused()` reported false while
`document.hasFocus()` inside that same guest reported true.

What the host does get is a `focusout` on whatever it had focused, a `window`
blur, and `document.activeElement` becoming the `<webview>` element. What the
region is actually decided from, in the end, is none of those: it is a
`pointerdown` capture listener reading the EVENT TARGET, because
`document.activeElement` settles on `BODY` for four of the five kinds of chrome
a user clicks, including one inside the browser column. `focusin` is kept for
the routes with no pointer event, such as tabbing in.

This is why the question was worth asking before writing the handler rather
than after: both approaches this document proposed would have compiled,
typechecked, read correctly, and never fired.

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

- Last browser closed: the reducer sets `activeBrowserTabId` to `null`, and the
  keys go back to the terminal region. Two details of what shipped are worth
  having straight (recorded 2026-08-12):
  - Config keeps the stale id. The renderer does send the `null` on, but
    `setActiveBrowser` in `src/main/ipc/register.ts` early-returns on it, so the
    last non-null id stays in the file. It is harmless because `describeProjects`
    re-resolves that field against the project's browser tabs on restore and
    answers `null` when there are none, but the file is not the truth here.
  - It is `keyRegion`, not `activeRegion`, that goes back to the terminal.
    `activeRegion` records where focus last went and nothing tells it the column
    left the screen; `keyRegion` is derived from `onScreenColumns.browser` on
    every render, which is exactly why it is derived rather than stored.
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
