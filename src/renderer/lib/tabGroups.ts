import type { TabDescriptor, TabRow } from '../../shared/ipc'

/**
 * One entry per pane, in the order the tab bar should draw them, with a split's
 * members tagged so the bar can frame them together.
 *
 * The bar lists PANES, one entry each: `tabsOfProject` (`workspace.ts:135`)
 * filters the flat `state.panes` array and hands the result straight to
 * `TabBar`. Splitting a tab adds a pane to that same flat array, so without
 * this, the new pane draws as an unrelated tab next to the one it came from —
 * and not even necessarily next to it. `applyTabShape` (`workspace.ts:875`)
 * keeps every existing pane where it already sat and appends anything new, so
 * a split of the first of three tabs lands its new sibling last, not second.
 *
 * `groupedTabs` fixes both problems at once: it moves a group's members next
 * to each other and tags each with its `groupId` and its `pos` within the
 * group, so the bar and the `⌥1..9` handler can both work off one array
 * instead of computing their own orderings and risking disagreement.
 */
export interface TabGroupEntry {
  pane: TabDescriptor
  /**
   * The `TabRow.id` whose `layout.kids` names this pane, or null when no row
   * does — true of a pane main has not yet filed under a tab.
   */
  groupId: string | null
  /**
   * This pane's place in its group's run of entries, or null when there is no
   * run: an ungrouped pane, or a row left holding only one present pane.
   *
   * A group of one gets `groupId` but not `pos` on purpose — `pos` is what
   * the renderer keys the frame off, and a frame around a single tab would
   * claim a split that no longer exists.
   */
  pos: 'first' | 'middle' | 'last' | null
}

/**
 * Reorders `panes` so each row's present members sit together, in
 * `layout.kids` order, and tags each with its group and place in it.
 *
 * Walks `panes` in the order given. The first time it reaches a pane whose
 * row has two or more members present in `panes`, it emits that row's
 * members there, in `kids` order, and marks them done; every later pane
 * belonging to that row is then skipped when its own turn comes. This is
 * what anchors a group at its earliest member's original position rather
 * than at the end of the array where `applyTabShape` actually appends new
 * panes.
 *
 * A `kids` entry absent from `panes` — another project's pane, or one main
 * has since dropped — does not count towards that "two or more" threshold
 * and never reaches the output, the same way `panesOfTab` (`workspace.ts:286`)
 * skips it. A row left with exactly one present member is not a split
 * worth framing: it is emitted as an ordinary ungrouped-looking entry,
 * except that `groupId` still names the row, since that fact is still true.
 */
export function groupedTabs(panes: TabDescriptor[], rows: TabRow[]): TabGroupEntry[] {
  const byId = new Map(panes.map((pane) => [pane.id, pane]))
  const rowByPaneId = new Map<string, TabRow>()
  for (const row of rows) {
    for (const kid of row.layout.kids) rowByPaneId.set(kid, row)
  }

  const emitted = new Set<string>()
  const entries: TabGroupEntry[] = []

  for (const pane of panes) {
    if (emitted.has(pane.id)) continue

    const row = rowByPaneId.get(pane.id)
    const present = row
      ? row.layout.kids
          .map((kid) => byId.get(kid))
          .filter((member): member is TabDescriptor => member !== undefined)
      : []

    if (row && present.length > 1) {
      present.forEach((member, index) => {
        emitted.add(member.id)
        entries.push({
          pane: member,
          groupId: row.id,
          pos: index === 0 ? 'first' : index === present.length - 1 ? 'last' : 'middle',
        })
      })
      continue
    }

    emitted.add(pane.id)
    entries.push({ pane, groupId: row?.id ?? null, pos: null })
  }

  return entries
}
