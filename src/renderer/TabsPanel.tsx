import { useState, type ReactNode } from 'react'
import { canHaveSession, type TabDescriptor, type TabState } from '../shared/ipc'
import type { TabTreeNode } from './lib/tabGroups'
import { StatusDot } from './StatusDot'
import { elapsedLabel } from './lib/elapsed'
import { tabLabel } from './lib/tabLabel'
import { useColumnWidth } from './lib/columnWidth'
import { ColumnResizer, PanelHeading, PanelStrip, type PanelSide } from './ui/Panel'
import { cn } from './lib/cn'

/**
 * The active project's tabs, with each tab's other panes nested beneath it.
 *
 * The vertical answer to a bar that runs out of room: `TabBar` is a single
 * `overflow-x-auto` row of `whitespace-nowrap` tabs ending in a `+` button, so
 * once enough tabs are open the row scrolls and the `+` button scrolls out of
 * view with it. A list scrolls without limit instead, and unlike a bar it has
 * somewhere to put a child, so a split reads as belonging to its tab rather
 * than as a neighbour of it.
 *
 * `App.tsx` renders the bar only while this column's full list is not open
 * (`showsTabBar`), so the tab list and the bar are never both on screen and
 * cannot disagree.
 */
export function TabsPanel({
  nodes,
  activeId,
  status,
  since,
  now,
  dead,
  collapsed,
  onToggle,
  onDragStart,
  onSelect,
  onClose,
  side,
}: {
  nodes: TabTreeNode[]
  activeId: string | null
  status: Record<string, TabState>
  since: Record<string, number>
  now: number
  /** Epoch ms a pane's session exited, keyed by pane id. Matches `TabBar`'s prop of the same name. */
  dead: Record<string, number>
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  onSelect: (paneId: string) => void
  onClose: (paneId: string) => void
  side: PanelSide
}) {
  const { width, set, commit } = useColumnWidth('pterm:tabsWidth', 208)
  // Which tabs are twisted shut. Local and not persisted: it is a glance-level
  // gesture, and a collapsed tab that survived a relaunch would hide panes the
  // user has forgotten they closed the twist on.
  const [shut, setShut] = useState<Set<string>>(() => new Set())

  if (collapsed) {
    return (
      <PanelStrip
        testid="tabs-toggle"
        label="Tabs"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
      />
    )
  }

  const row = (pane: TabDescriptor, depth: number, last: boolean, twist: ReactNode) => {
    const label = elapsedLabel(since[pane.id] ?? null, now)
    // Matches `TabBar`'s own `tombstoned`: a terminal pane whose session has
    // exited has nothing left for `onClose` to kill. `TabBar` swaps in
    // Restart/Dismiss for this case instead of a close control; this column
    // does not offer either yet, so the honest thing is to offer neither
    // control rather than a × that reaches `manager.kill()` and throws.
    const tombstoned = canHaveSession(pane) && dead[pane.id] !== undefined
    return (
      <div
        key={pane.id}
        data-testid={depth === 0 ? `vtab-${pane.id}` : `vpane-${pane.id}`}
        onClick={() => onSelect(pane.id)}
        className={cn(
          'group flex cursor-default items-center gap-1 py-0.5 pr-1 text-[11px]',
          pane.id === activeId ? 'bg-surface text-fg' : 'text-muted hover:text-fg',
        )}
        style={{ paddingLeft: depth === 0 ? 8 : 20 }}
      >
        {twist}
        {depth > 0 ? (
          <span aria-hidden className="shrink-0 font-mono text-faint">{last ? '└' : '├'}</span>
        ) : null}
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-sm border border-border"
          style={{ background: pane.color ?? undefined }}
        />
        <span className="flex-1 truncate">{tabLabel(pane)}</span>
        {label === null ? null : <span className="shrink-0 text-faint">{label}</span>}
        <StatusDot state={status[pane.id] ?? null} testid={`vdot-${pane.id}`} />
        {tombstoned ? null : (
          <button
            data-testid={`vclose-${pane.id}`}
            aria-label={`Close ${tabLabel(pane)}`}
            className="shrink-0 cursor-default border-none bg-transparent px-1 text-faint opacity-0 group-hover:opacity-100 hover:text-fg"
            onClick={(event) => {
              // Or the row's own click would select the pane on its way out.
              event.stopPropagation()
              onClose(pane.id)
            }}
          >
            ×
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      data-testid="tabs-panel"
      className="relative flex shrink-0 flex-col border-r border-border bg-bg"
      style={{ width }}
    >
      <PanelHeading
        testid="tabs-heading"
        label="Tabs"
        onClick={onToggle}
        onDragStart={onDragStart}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {nodes.map((node) => {
          // In the row's own flex flow, the same way `FileTree`'s twist is a
          // fixed-width flex child rather than something floated over the
          // row: that is a slot the row's own layout reserves, not a
          // position guessed at with no offsets and no positioned ancestor.
          // A childless tab still reserves the slot with a blank span, the
          // same trade `FileTree` makes for a file next to a directory, so
          // every tab's swatch lines up on the same x regardless of which
          // rows have one.
          const twist =
            node.children.length === 0 ? (
              <span aria-hidden className="h-3 w-3 shrink-0" />
            ) : (
              <button
                data-testid={`vtwist-${node.pane.id}`}
                aria-label={shut.has(node.pane.id) ? 'Expand' : 'Collapse'}
                className="flex h-3 w-3 shrink-0 cursor-default items-center justify-center border-none bg-transparent text-center text-[9px] leading-none text-faint hover:text-fg"
                onClick={(event) => {
                  // Or the row's own click would also select the pane.
                  event.stopPropagation()
                  setShut((previous) => {
                    const next = new Set(previous)
                    if (!next.delete(node.pane.id)) next.add(node.pane.id)
                    return next
                  })
                }}
              >
                {shut.has(node.pane.id) ? '▸' : '▾'}
              </button>
            )
          return (
            <div key={node.pane.id}>
              {row(node.pane, 0, false, twist)}
              {shut.has(node.pane.id)
                ? null
                : node.children.map((kid, index) =>
                    row(kid, 1, index === node.children.length - 1, null),
                  )}
            </div>
          )
        })}
      </div>
      <ColumnResizer testid="tabs-resizer" side={side} width={width} onResize={set} onCommit={commit} />
    </div>
  )
}
