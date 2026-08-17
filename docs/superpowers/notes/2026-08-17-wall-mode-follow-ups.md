# Wall mode: what shipped knowingly unfinished

2026-08-17, alongside `specs/2026-08-17-prcli-wall-mode-design.md` and
`plans/2026-08-17-wall-mode.md`.

Nine tasks, fourteen commits, each task reviewed and a whole-branch review at the
end. No correctness defect was left open. What follows is what the reviews found
and we decided to ship anyway, so the next person changing this feature does not
have to rediscover it.

## The measured limit, and the cap that does not exist

`tests/e2e/wall.spec.ts`'s last test measures the thing the spec flagged as the
feature's open risk. At 2x2 with every cell holding a split tab, 8 of 8 panes kept
a WebGL context, against a budget of 12 and Chromium's measured cap of 16.

The ceiling that matters is **slot count times panes per slot, not column count**.
Eight slots at two panes each is 16 and over budget whatever the column count;
four slots at three panes each is 12 and at it. Nothing caps `slots.length` today.
Past the budget `claimRenderer` degrades correctly (the pane past it stays on the
DOM renderer rather than taking a context from a pane on screen), but "correctly"
there means somebody's cell draws Claude Code's block characters as slivers.

No cap was added: the measurement says the feature as shipped is well inside
budget, and a cap was scope the spec never asked for. If one is ever wanted, the
honest place is `src/renderer/lib/wallSlots.ts` beside `WALL_COLUMNS_MAX`, phrased
against the budget rather than against a column count. The comment there records
this.

## Known rough edges, in the order they are likely to bite

1. **Follow-active makes the pin picker confusing.** While a project is following
   its active pane, the picker's check sits on the *active* pane, so clicking that
   row sends `onPin(null)` and clears the stored pin, and clicking any other row
   writes a pin the cell will not show. Either way nothing on screen changes, so
   the user gets no feedback. Not a dead end (turning follow off reveals the
   result). The cheapest fix is to make the rows inert while following, leaving
   the "Follow active pane" row as the only live control, or to have a row click
   turn follow off as it pins. No test covers this: e2e never turns follow on and
   never opens the picker.
2. **A stale pin on a project with no live terminal panes cannot be cleared.** The
   unpin row only exists while something is pinned, and main resolves a pin's owner
   from the pane it names, so there is nothing to name. The cell reads "the pinned
   pane is gone" until a terminal is opened in that project or it leaves the wall.
   This is the one place the pane-names-its-owner design has a cost.
3. **The optimistic pin and the config write can disagree silently.** The renderer
   patches its own project row beside a fire-and-forget IPC send, and
   `withWallPin` returns the config unchanged if the pane is unknown to it. A
   relaunch repairs it, and no error is shown. The eventual shape is for the
   `setWallPin` handler to emit the usual `projects` push after the write, which
   would remove the need for the local patch to be the only source of truth.
4. **`pt-6` on a wall group and `WallCell`'s `h-[22px]` plus its 2px strip are
   coupled by two comments and nothing else**, with zero slack. Anything that makes
   the header taller puts the terminal's top row back under an opaque bar, which no
   test would catch. A shared token is the answer if the header is ever touched.
5. **`appLayout.test.ts` guards `inset-0` against migrating into the static class
   string but does not guard `pt-6`**, which is the same hazard: it would silently
   cost every normal-mode group 16px of measured height and refit every tmux
   session in the app.

## Two spec routes not delivered

The spec asked for a pin marker on the sidebar row of a project holding a slot, and
for `Pin to wall` on a tab's own context menu in normal mode. The plan dropped both:
the sidebar's `inWall` only chooses a context-menu label, and the palette's "Pin this
pane to the wall" stands in for the tab menu (which means activating the pane first).
Neither is hard to add.

## One thing worth knowing about dead panes

Killing a pinned session does **not** draw the empty cell. `workspace.ts`'s `died`
case deliberately keeps a dead pane in `state.panes` so the scrollback survives and
Restart and Dismiss have something to act on, so the cell keeps showing the dead
pane's chrome. The placeholder is reached by dismissing it, or by a pin surviving a
relaunch its pane did not. `wall.spec.ts` asserts both steps in that order.
