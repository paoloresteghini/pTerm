import type { TabDescriptor } from '../../shared/ipc'
import type { PaneRecord } from '../sessions/manager'

/**
 * Put saved titles back onto freshly built descriptors.
 *
 * Every path that answers with panes builds them from live tmux by way of
 * `SessionManager`, which knows nothing about titles and should not: a pane's
 * session is named `prcli-${slug}-${id}`, and that name is what restore
 * matches saved rows by. A title is display text stored beside it.
 *
 * So the title is reattached here instead, in the one function all three of
 * those paths call, rather than threaded through `OpenInput` and back out
 * again. A pane with no saved row, or a row with no title, is returned exactly
 * as it came in.
 */
export function attachTitles(panes: TabDescriptor[], records: PaneRecord[]): TabDescriptor[] {
  const titles = new Map(records.filter((row) => row.title).map((row) => [row.id, row.title]))
  return panes.map((pane) => {
    const title = titles.get(pane.id)
    return title === undefined ? pane : { ...pane, title }
  })
}
