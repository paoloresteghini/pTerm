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

  /**
   * Which corner of its group's bracket a row draws, or null when the group is
   * one pane and there is nothing to bracket.
   *
   * The bracket is the whole point of the group shape: a split's panes are
   * peers, so they sit at ONE indent joined down the left, rather than one
   * being indented beneath the other as though it were contained by it.
   */
  const bracketAt = (index: number, size: number): 'first' | 'middle' | 'last' | null => {
    if (size < 2) return null
    if (index === 0) return 'first'
    return index === size - 1 ? 'last' : 'middle'
  }

  const row = (pane: TabDescriptor, bracket: 'first' | 'middle' | 'last' | null) => {
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
        // Every row is a pane, so every row is named the same way. The old
        // `vtab-`/`vpane-` split encoded a parent and a child, which is the
        // hierarchy this shape exists to remove; where a row sits in its
        // group is reported by `data-bracket` instead.
        data-testid={`vpane-${pane.id}`}
        data-bracket={bracket ?? undefined}
        onClick={() => onSelect(pane.id)}
        className={cn(
          'group flex cursor-default items-center gap-1 py-0.5 pr-1 text-[11px]',
          pane.id === activeId ? 'bg-surface text-fg' : 'text-muted hover:text-fg',
        )}
        style={{ paddingLeft: 8 }}
      >
        {/* One slot, always reserved, so every swatch lines up on the same x
            whether or not its row is part of a split. The same trade
            `FileTree` makes for a file sitting next to a directory. */}
        <span aria-hidden className="w-3 shrink-0 font-mono text-faint">
          {bracket === 'first' ? '┌' : bracket === 'middle' ? '├' : bracket === 'last' ? '└' : ''}
        </span>
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
      className={cn(
        'relative flex shrink-0 flex-col border-border bg-bg',
        side === 'left' ? 'border-r' : 'border-l',
      )}
      style={{ width }}
    >
      <PanelHeading
        testid="tabs-heading"
        label="Tabs"
        onClick={onToggle}
        onDragStart={onDragStart}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {nodes.map((node) => (
          <div key={node.panes[0]?.id ?? ''}>
            {node.panes.map((pane, index) => row(pane, bracketAt(index, node.panes.length)))}
          </div>
        ))}
      </div>
      <ColumnResizer testid="tabs-resizer" side={side} width={width} onResize={set} onCommit={commit} />
    </div>
  )
}
