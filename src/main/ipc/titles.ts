import type { TabDescriptor } from '../../shared/ipc'
import type { PaneRecord } from '../sessions/manager'

/**
 * Put saved titles back onto records built from live tmux.
 *
 * `SessionManager` knows nothing about titles and should not: a pane's session
 * is named `prcli-${slug}-${id}`, and that name is what restore matches saved
 * rows by. A title is display text stored beside it. So a record the manager
 * built carries none, and the title is reattached here rather than threaded
 * through `OpenInput` and back out again. A pane with no saved row, or a row
 * with no title, is returned exactly as it came in.
 *
 * This is NOT a central solution to titles, and reading it as one is how two
 * handlers came to write titleless rows over titled ones. It has exactly two
 * callers, and each calls it once, on an array used for both the reply and the
 * `store.write` that feeds the next launch:
 *
 * - `restoreWorkspace` (`restore.ts`), on the panes `manager.open()` returned
 * - `CHANNELS.moveTabToProject` (`register.ts`), on the records
 *   `manager.moveTabToProject` rebuilt
 *
 * Anything else answering with panes reattaches nothing, and here is why each
 * is currently acceptable:
 *
 * - `CHANNELS.splitPane` and `CHANNELS.closePane` answer from `config.panes`
 *   via `held(...)`, and `CHANNELS.renameTab` from the rows it just wrote, so
 *   all three already carry whatever is on disk. Only the pane a split creates
 *   is manager-built, and a brand-new pane has no saved title to lose.
 * - `CHANNELS.open` is manager-built, but the renderer only ever asks it for a
 *   new pane (`App.tsx` passes no id), so likewise there is nothing to reattach.
 * - `CHANNELS.restartTab` is manager-built and DOES replace the saved row with
 *   a titleless one. It is not covered here because by then there is usually
 *   no title left to carry: `forgetTab` deletes the whole pane row when a
 *   session exits. A name does not survive its pane's death, which is a
 *   ticketed scope line, not something this function papers over.
 * - `CHANNELS.list` is manager-built and reattaches nothing, and is inert:
 *   nothing in `src/renderer` or `tests/` calls `window.prcli.list()`.
 */
export function attachTitles(panes: TabDescriptor[], records: PaneRecord[]): TabDescriptor[] {
  const titles = new Map(records.filter((row) => row.title).map((row) => [row.id, row.title]))
  return panes.map((pane) => {
    const title = titles.get(pane.id)
    return title === undefined ? pane : { ...pane, title }
  })
}
