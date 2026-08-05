import type { TabDescriptor } from '../../shared/ipc'
import type { PaneRecord } from '../sessions/manager'

/**
 * Put the fields only config knows about back onto records built from live
 * tmux: the pane's title, its colour, and the file an editor pane is showing.
 *
 * `SessionManager` knows nothing about any of them and should not: a pane's
 * session is named `prcli-${slug}-${id}`, and that name is what restore matches
 * saved rows by. A title, a colour and a file path are display data stored
 * beside it. So a record the manager built carries none of them, and all three
 * are reattached here rather than threaded through `OpenInput` and back out
 * again. A pane with no saved row, or a row with none of the fields set, is
 * returned exactly as it came in.
 *
 * All three, in one pass, deliberately. This was `attachTitles` and carried
 * only the title, and adding the colour beside it as a second function is how a
 * pane would come back from a relaunch named but grey. That is not
 * hypothetical: it is what happened, and the e2e that caught it is
 * `right-clicking a pane recolours it` in `splits.spec.ts` — the colour was
 * correct on screen, correct on disk, and gone after `app.close()`. `filePath`
 * joined them for the same reason and would fail the same way: an editor pane
 * that reopens blank rather than on its file, with nothing thrown. Anything
 * added to `PaneRecord` that the manager cannot derive belongs in this map too.
 *
 * **`filePath` is the one of the three that nothing currently depends on this
 * function for, and saying so is the point.** Measured 2026-08-04: deleting the
 * `filePath` line and running `editorRestore.spec.ts` leaves all three tests
 * passing. An editor pane reaches this function by a different route from the
 * other two — it never had a session for `manager.open()` to build a record
 * from, so it is not in `panes` at all until `mergeSessionlessPanes` puts the
 * SAVED row itself there, `filePath` and all, with nothing for this map to put
 * back. The line is kept because that is a property of today's one producer
 * rather than of the field: any future path that hands restore a manager-built
 * editor pane would arrive here stripped, exactly as a titled pane does, and
 * the failure would be silent. It is defence, and it is not the thing under
 * test — `mergeSessionlessPanes` is what carries the file path today.
 *
 * That defence is now specified rather than merely asserted:
 * `tests/unit/savedFields.test.ts` calls this function directly with a record
 * that has no `filePath`, which is what such a future producer would hand it,
 * and measured 2026-08-04 the line's deletion fails it — `Expected
 * "/tmp/demo/a.ts"`, `Received undefined`. Direct is load-bearing: the same
 * assertion made through `restoreWorkspace` would pass with the line gone, for
 * the reason the paragraph above gives, and would be a test of the merge under
 * this function's name.
 *
 * This is NOT a central solution, and reading it as one is how two handlers
 * came to write bare rows over saved ones. It has exactly two callers, and each
 * calls it once, on an array used for both the reply and the `store.write` that
 * feeds the next launch:
 *
 * - `restoreWorkspace` (`restore.ts`), on the panes `manager.open()` returned
 * - `CHANNELS.moveTabToProject` (`register.ts`), on the records
 *   `manager.moveTabToProject` rebuilt
 *
 * Anything else answering with panes reattaches nothing, and here is why each
 * is currently acceptable:
 *
 * - `CHANNELS.splitPane` and `CHANNELS.closePane` answer from `config.panes`
 *   via `held(...)`, and `CHANNELS.renameTab` and `CHANNELS.setPaneColor` from
 *   the rows they just wrote, so all four already carry whatever is on disk.
 *   Only the pane a split creates is manager-built, and a brand-new pane has
 *   neither field to lose.
 * - `CHANNELS.open` is manager-built, but the renderer only ever asks it for a
 *   new pane (`App.tsx` passes no id), so likewise there is nothing to reattach.
 * - `CHANNELS.restartTab` is manager-built and DOES replace the saved row with
 *   a bare one. It is not covered here because by then there is usually nothing
 *   left to carry: `forgetTab` deletes the whole pane row when a session exits.
 *   Neither a name nor a colour survives its pane's death, which is a ticketed
 *   scope line, not something this function papers over.
 * - `CHANNELS.list` is manager-built and reattaches nothing, and is inert:
 *   nothing in `src/renderer` or `tests/` calls `window.prcli.list()`.
 */
export function attachSavedFields(panes: TabDescriptor[], records: PaneRecord[]): TabDescriptor[] {
  const saved = new Map(records.map((row) => [row.id, row]))
  return panes.map((pane) => {
    const row = saved.get(pane.id)
    if (row === undefined) return pane
    // Field by field, and only when set. Spreading the whole saved row would
    // put config's stale idea of `cwd`, `tmuxSession` and `type` over what
    // live tmux just reported, which is the opposite of why restore matches
    // rows against sessions at all.
    const next = { ...pane }
    if (row.title) next.title = row.title
    if (row.color) next.color = row.color
    if (row.filePath) next.filePath = row.filePath
    return next
  })
}
