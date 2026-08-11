import { useState } from 'react'

/**
 * Drag-to-join handler props for one pane's element, and the pane currently
 * under a valid drag.
 *
 * Shared by `TabsPanel` and `TabBar` so the two surfaces behave identically
 * by construction rather than by two handlers happening to agree. Neither
 * surface derives its own refusal rule: `canJoin` and `onJoin` are passed in
 * from `App.tsx`, which is the only place that knows about tab rows and
 * projects.
 */
export interface PaneDragDrop {
  /** Spread onto the element representing `paneId`. */
  propsFor: (paneId: string) => {
    draggable: true
    onDragStart: (event: React.DragEvent) => void
    onDragEnd: () => void
    onDragOver: (event: React.DragEvent) => void
    onDragLeave: () => void
    onDrop: (event: React.DragEvent) => void
  }
  /** The pane currently under a valid drag, for the drop highlight. */
  over: string | null
}

// A bare `text/plain` would let any dragged text look like a pane id, and
// would let a pane id dropped into a terminal read as a paste.
const MIME = 'application/x-pterm-pane'

/**
 * One drag gesture: pick up a pane by its row or tab, hover another, drop to
 * join them. `canJoin` and `onJoin` are the caller's rule and action; this
 * hook only owns the two pieces of state the gesture itself needs.
 *
 * `dragged` exists because `dataTransfer.getData` returns an empty string
 * during `dragover` by browser design: only the TYPE is readable there, not
 * the value. So the id the refusal rule needs during the hover has to be
 * held in state, and `getData` is used only on `drop`, where it does work.
 */
export function usePaneDragDrop(
  canJoin: (from: string, to: string) => boolean,
  onJoin: (from: string, to: string) => void,
): PaneDragDrop {
  const [dragged, setDragged] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  return {
    over,
    propsFor: (paneId: string) => ({
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        // Defensive, and stopping nothing today. The only other drag sources
        // in the renderer are the column handles (`Panel.tsx` sets
        // `draggable` from `onDragStart`), and none of them is an ANCESTOR of
        // a row or a tab: the tabs column's handle is its `PanelHeading`, a
        // sibling of the rows container, and the tab bar sits inside no
        // draggable at all. This is here so that a handle wrapped around
        // either surface later cannot turn a row drag into a column drag.
        event.stopPropagation()
        event.dataTransfer.setData(MIME, paneId)
        event.dataTransfer.effectAllowed = 'move'
        setDragged(paneId)
      },
      onDragEnd: () => {
        setDragged(null)
        setOver(null)
      },
      onDragOver: (event: React.DragEvent) => {
        if (!dragged || !canJoin(dragged, paneId)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setOver(paneId)
      },
      onDragLeave: () => setOver((was) => (was === paneId ? null : was)),
      onDrop: (event: React.DragEvent) => {
        // `|| dragged` covers a drop that arrives with a cleared `dataTransfer`.
        const from = event.dataTransfer.getData(MIME) || dragged
        setOver(null)
        setDragged(null)
        if (!from || !canJoin(from, paneId)) return
        event.preventDefault()
        onJoin(from, paneId)
      },
    }),
  }
}
