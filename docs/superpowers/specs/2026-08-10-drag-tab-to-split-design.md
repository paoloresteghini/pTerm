# Drag a tab onto another to merge them into a split: design

Date: 2026-08-10

Three separate tabs, and the user wants two of them side by side. Today the
only route is to close one and split the other, which throws away whatever was
running in the tab that got closed. This adds the direct gesture: drag one tab
onto another and the two become one split tab, with both shells and both
scrollbacks intact.

The hard requirement, stated by the user and the reason approach B below was
rejected: **the merge must not kill the progress or work in either tab.**

## What a tab actually is

A tab is a tmux **session group**. A pane is one session in that group, bound to
one window. Splitting today (`splitPane` → `SessionManager.splitTab` →
`addMember`) creates a *new* window and a *new* session in the target's group.
Nothing in the app moves an *existing* pane between tabs.

That matters more than it looks, because tab membership is not stored. It is
re-derived. `restoreWorkspace` rebuilds every tab from live tmux
`session_group` on each launch (`src/main/ipc/restore.ts:302-314`), and saved
rows only supply what tmux cannot report: the axis, the ratios and the tab id.
So a merge that rewrites renderer state without changing tmux is correct on
screen, correct on disk, and gone on relaunch.

## Approaches considered

**A. Move the tmux window into the target group.** The window carries the
shell, so the process and its scrollback survive the move. Requires two new
adapter commands and one ordering rule that is easy to get wrong (§ "The step
that is load-bearing"). **Chosen.**

**B. Recreate the pane.** Kill the dragged pane, then call the existing
`splitPane` against the target with the same cwd, command and type. Nearly free
to build, since it reuses `splitTab` wholesale. It also kills the running process
and the scrollback, which is exactly what the user ruled out. Rejected.

**C. Renderer-only regroup.** Rewrite the `TabRow` in the store and leave tmux
alone. Zero tmux risk. But restore re-derives membership from `session_group`,
so the split evaporates on the next launch, and `groupNameOf` would then hand a
later split of that tab the wrong group. Rejected.

## The tmux mechanism, as measured

Not taken from the tmux manual. Run on a throwaway socket on 2026-08-10, with
the pids recorded before and after:

```
move-window  -s '=<paneSession>:' -t '=<aTargetGroupMember>:'
kill-session -t '=<paneSession>'                      # tolerate "not found"
new-session  -d -t '=<targetGroup>' -s <same session name>
select-window ...                                     # per member, see below
```

What the probe established:

- The shell survives. A pane's pid was unchanged across the move in every run,
  including a run that moved the pane from one existing split into another.
- The pane id survives, because the session name is reused. Nothing downstream
  has to be told the pane was renamed, since it wasn't.
- The source group correctly loses the window: after moving one member out of a
  two-member group, the remaining session listed only its own window.
- A standalone tab's session self-destructs at `move-window`, having no windows
  left. A split member's session does not, because it still sees its siblings'
  shared windows. So `kill-session` must tolerate an already-gone session rather than
  treating it as a failure.
- Dragging the pane that *founded* a group is safe. The moved pane joined the
  target group and the survivor kept reporting the frozen old group name, with
  its own window and a live pid.
- Per-session window selection is independent: re-selecting in one group member
  did not disturb any other member.

## The step that is load-bearing

`move-window` re-selects the moved window **in the target session**. In the
probe this left two sessions of one group both showing the same window.

Elsewhere that would be cosmetic. Here it is destructive on a delay:
`withoutSharedWindows` (`src/main/ipc/restore.ts:154-162`) reads two sessions
sharing a window as one shadowing the other and calls `killShadowMember` on it.
A join that skips the re-selection therefore looks perfect, survives the rest of
the session, and silently kills a live pane on the next relaunch.

So the operation snapshots every target-group member's selected window id before
the move and restores all of them after. This is not tidying; it is the
difference between a working feature and delayed data loss.

## The operation

A new `joinPane(paneId, targetPaneId)` on the bridge, answering with the same
`TabShape` that `splitPane` and `closePane` already answer with. The caller
needs the new `kids` order and the redistributed ratios anyway, and a renderer
patching its own arrays from a partial reply is a second place for tab
membership to drift from what main just wrote.

Two new `TmuxAdapter` methods: `moveWindow(srcSession, dstSession)` and
`selectedWindowOf(session)`.

Order, and why each step sits where it does:

1. **Detach the moved pane's pty.** Step 4 kills a session; if the renderer is
   still attached, the app sees a death it did not ask for and renders the pane
   as a crash. Detaching first keeps it out of the tombstone path entirely.
2. **Snapshot** the target group name, the moved pane's window id, and every
   target-group member's currently selected window id.
3. **`move-window`.** The only step that touches the shell, and it moves it
   rather than replacing it.
4. **`kill-session`** on the now-redundant source session, tolerating
   "not found" per the measured behaviour above.
5. **`new-session -d -t <targetGroup> -s <same name>`**, guarded by
   `has-session` so a step-4 kill that silently failed is caught here rather
   than becoming a name collision. Reusing the name is what keeps the pane id,
   the `PTERM_TAB_ID` session env and the window's death hook valid with no
   rewiring.
6. **Restore every snapshotted selection**, then select the moved window in its
   own session.
7. Update the moved pane's `Entry.tabId` and `tabWasIn`, rewrite both tab rows,
   and reattach the pty at the target tab's geometry.

## Failure handling

No step kills a shell, so the worst reachable outcome is a stranded window, not
lost work.

- Step 3 failing changes nothing; the join is refused and reported.
- Step 5 failing leaves the shell alive inside the target group with no session
  naming it. Recovery is the same operation reversed: move the window back to a
  member of the source group and recreate the source session under its own
  name.
- One session that will not move must not cost the user the tabs that did. The
  refusal is surfaced, not swallowed, because a silent failure here is
  indistinguishable from a drop that missed.

## Gesture and refusals

Every row in `TabsPanel` and every tab in `TabBar` becomes `draggable`, carrying
its **pane id** in `dataTransfer`. HTML5 drag events, matching the column-reorder
drag already in `App.tsx`, rather than pointer events. Same idiom, and
`dataTransfer` is a natural carrier for the id.

The unit of the gesture is always **one pane**, dropped on **one pane**. The
dragged pane joins the target's tab. All four of these are allowed:

| Drag | Drop on | Result |
|------|---------|--------|
| standalone tab | standalone tab | the two become a split |
| standalone tab | a split's member | joins that split |
| a split's member | standalone tab | leaves its split, forms a new one |
| a split's member | another split's member | moves between splits |

Refused, with no drop indicator and `dropEffect = 'none'`: dropping a pane on
itself, on a sibling already in the same tab, or on a pane in a different
project.

The whole target row is the drop zone. There are no edge zones: rows in the
tabs column are about 20px tall, so top and bottom bands would be roughly 7px
each, and they would collide with any later reorder-between-rows gesture.

## Axis and insertion

`SplitRequest.dir` is documented as *always* re-orienting the tab it lands in
(`src/shared/ipc.ts:469-481`), a deliberate ruling from 2026-08-06, made
because an already-split tab could not be split rightward by any route and
nothing said so.

**Join deliberately diverges: it keeps the target tab's existing axis**, and
defaults to `row` only when the target is not split yet. The reason the original
ruling holds is that `dir` there carries an axis the user explicitly asked for.
A whole-row drop carries no axis at all, so honouring an unstated `row` would
silently flip a user's column split sideways because they dragged a tab into it.

The joining pane appends last in `layout.kids`, and ratios are redistributed
through the same path `splitPane` already uses.

## Which pane is active afterwards

Two rows change on every join, so both `activePaneId` fields need an answer,
and neither is a detail the implementation can be left to guess.

The **target** tab's `activePaneId` becomes the joined pane. The user dragged it
somewhere deliberately; landing focus anywhere else means the gesture completes
and then the app looks at something the user did not choose.

The **source** tab, when the moved pane was the one it had marked active, falls
back to the first pane still in its `kids`. When the source tab had only that
one pane, its row is dropped entirely, which is the same path `closePane`
already takes for a tab whose last pane has gone.

The moved pane also becomes the active pane of its project, so the join both
merges and navigates. This mirrors what splitting already does.

## A restore consequence worth writing down

A tmux group's name is frozen at creation from the session that made it. After a
founder is dragged out, the group it left keeps that name. Measured: the
survivor still reported the departed founder's name as its group.

So a `TabRow.id` can name a pane that now lives in a different tab. Everything
resolves membership through `layout.kids` (`tabOfPane`, `groupedTabs`,
`tabTree`), so nothing today is wrong. The constraint this creates: nothing may
start re-deriving a row's id from its current membership.

## Testing

The user's constraint is a testable claim, so it gets the most direct test
available rather than a proxy:

- **Integration, real tmux on a dedicated socket:** for each of the four allowed
  transitions, assert `pane_pid` is *identical* before and after the join. This
  is the direct test that no work was killed.
- **Integration:** after a join, every member of the target group reports a
  distinct window. This is the `killShadowMember` regression, and it fails
  against an implementation that skips step 6 while every other test passes.
- **Integration:** joining the founder of a two-pane split leaves the survivor
  live, with its own window.
- **Unit:** `kids` ordering, ratio redistribution, axis preservation on an
  already-`col` target, and each refusal case.
- **E2E:** Playwright's `dragTo` does not drive HTML5 drag-and-drop reliably in
  Electron, so the drag specs dispatch `DataTransfer` events directly. Cover the
  drop indicator appearing on a valid target and staying absent on a refused
  one.

## Out of scope

- Dragging a whole multi-pane tab so that all of its panes merge at once. More
  tmux moves per gesture and more partial-failure states, for a gesture nobody
  has asked for yet.
- Dropping on empty space to pull a pane out of a split and make it standalone.
  Every join in scope moves a pane from one group into another; nothing here
  ever needs to leave a pane ungrouped, so the un-group path stays unwritten.
