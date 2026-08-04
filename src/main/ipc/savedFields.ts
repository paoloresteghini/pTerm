import type { TabDescriptor } from '../../shared/ipc'
import type { PaneRecord } from '../sessions/manager'

/**
 * Put the fields only config knows about back onto records built from live
 * tmux: the pane's title and its colour.
 *
 * `SessionManager` knows nothing about either and should not: a pane's session
 * is named `prcli-${slug}-${id}`, and that name is what restore matches saved
 * rows by. A title and a colour are display data stored beside it. So a record
 * the manager built carries neither, and both are reattached here rather than
 * threaded through `OpenInput` and back out again. A pane with no saved row,
 * or a row with neither field set, is returned exactly as it came in.
 *
 * Both, in one pass, deliberately. This was `attachTitles` and carried only the
 * title, and adding the colour beside it as a second function is how a pane
 * would come back from a relaunch named but grey. That is not hypothetical: it
 * is what happened, and the e2e that caught it is
 * `right-clicking a pane recolours it` in `splits.spec.ts` — the colour was
 * correct on screen, correct on disk, and gone after `app.close()`. Anything
 * added to `PaneRecord` that the manager cannot derive belongs in this map too.
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
    return next
  })
}
