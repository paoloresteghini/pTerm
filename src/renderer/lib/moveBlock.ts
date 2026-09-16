/**
 * Move a run of ids to sit `place` the target, keeping everything else in
 * order.
 *
 * `moving` is a run rather than a single id because a split tab drags as one
 * thing: the sidebar shows its panes as indented peers of one row, and the
 * pane layout draws them in that order, so pulling one out of the run in the
 * list would claim a rearrangement the layout cannot make.
 *
 * `place` is passed rather than derived from `order` because the two are not
 * always the same list. A project drag is judged by where the rows sit on
 * screen (live group first, dormant sorted by when it was closed) but applied
 * to the stored order, which is what `reorderProjects` writes. Deriving the
 * direction here would read it off the wrong one of the two, and would do it
 * silently, in the one case where the answer is still a valid-looking order.
 *
 * Dropping a run on itself is a no-op, as is a target the order does not
 * hold: both are the ordinary end of a drag that went nowhere, not an error
 * worth throwing over. Both fall out of the same test, because a target
 * inside the run is not in the remainder either.
 */
export function moveBlock(
  order: readonly string[],
  moving: readonly string[],
  target: string,
  place: 'before' | 'after',
): string[] {
  const block = moving.filter((id) => order.includes(id))
  if (block.length === 0) return [...order]

  const rest = order.filter((id) => !block.includes(id))
  const at = rest.indexOf(target)
  if (at === -1) return [...order]

  const cut = place === 'after' ? at + 1 : at
  return [...rest.slice(0, cut), ...block, ...rest.slice(cut)]
}
