/**
 * Which panes have unsaved edits.
 *
 * A plain map in `App.tsx` rather than state inside each pane, because the two
 * things that need the answer are outside the pane: the tab bar draws the dot,
 * and the close path has to ask before destroying the pane. Neither can reach
 * inside a `FileView`.
 *
 * Never persisted. A pane that was dirty when the app closed reopens showing
 * what is on disk, because what is on disk is all that survived. The store
 * learns nothing about dirtiness in this slice.
 */
export type DirtyPanes = Record<string, boolean>

/**
 * `panes` with `paneId` marked, or the same object if that changes nothing.
 *
 * Clean is ABSENCE rather than `false`: one spelling of "not dirty", so
 * nothing that reads this map can disagree about which it means. The
 * identity return is load-bearing and not a micro-optimisation: this runs on
 * every keystroke, and a fresh object each time re-renders the whole tab bar
 * while the user is typing.
 */
export function markDirty(panes: DirtyPanes, paneId: string, dirty: boolean): DirtyPanes {
  if (dirty === (panes[paneId] === true)) return panes
  if (!dirty) {
    const next = { ...panes }
    delete next[paneId]
    return next
  }
  return { ...panes, [paneId]: true }
}

/** `panes` without `paneId`, or the same object if it was not in it. */
export function forgetPane(panes: DirtyPanes, paneId: string): DirtyPanes {
  if (panes[paneId] === undefined) return panes
  const next = { ...panes }
  delete next[paneId]
  return next
}
