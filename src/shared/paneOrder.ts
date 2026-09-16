/**
 * Reorder the entries named by `ids` among the positions they already hold.
 *
 * A slot fill, not a splice: the indices `items` gives to the named entries
 * are collected, and those same indices are refilled in `ids` order. Every
 * entry `ids` does not name keeps the exact index it had.
 *
 * That is the whole reason this is not `[...named, ...rest]`. A pane's tab
 * order is its position in one flat array shared by every project, so a
 * reorder inside one project has to leave the other projects' panes where
 * they sit. Rebuilding the array from the named entries plus the remainder
 * would move a project's whole run to the front of the window the first time
 * anyone dragged a tab in it.
 *
 * Written once and read by both sides of the wire: `main/ipc/register.ts`
 * applies it to `config.panes` before writing, and the `reorderedPanes`
 * reducer applies it to `state.panes`. Two copies of a rule this positional
 * would be two orders to disagree about, and the disagreement would only
 * show after a relaunch, when the disk's answer replaced the window's.
 *
 * Unknown ids are ignored and duplicates are collapsed, so a stale list from
 * a renderer that has since lost a pane reorders what it still can rather
 * than throwing or dropping rows.
 */
export function reorderById<T extends { id: string }>(
  items: readonly T[],
  ids: readonly string[],
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const moving: T[] = []
  const claimed = new Set<string>()
  for (const id of ids) {
    const item = byId.get(id)
    if (!item || claimed.has(id)) continue
    claimed.add(id)
    moving.push(item)
  }
  if (moving.length === 0) return [...items]

  const next = [...items]
  let taken = 0
  for (let index = 0; index < next.length; index += 1) {
    if (!claimed.has(next[index].id)) continue
    next[index] = moving[taken]
    taken += 1
  }
  return next
}
