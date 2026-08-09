import { useState } from 'react'
import type { TabDescriptor, TabState } from '../shared/ipc'
import type { TabTreeNode } from './lib/tabGroups'
import { StatusDot } from './StatusDot'
import { elapsedLabel } from './lib/elapsed'
import { tabLabel } from './lib/tabLabel'
import { useColumnWidth } from './lib/columnWidth'
import { ColumnResizer, PanelHeading, PanelStrip } from './ui/Panel'
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
  collapsed,
  onToggle,
  onSelect,
  onClose,
}: {
  nodes: TabTreeNode[]
  activeId: string | null
  status: Record<string, TabState>
  since: Record<string, number>
  now: number
  collapsed: boolean
  onToggle: () => void
  onSelect: (paneId: string) => void
  onClose: (paneId: string) => void
}) {
  const { width, set, commit } = useColumnWidth('pterm:tabsWidth', 208)
  // Which tabs are twisted shut. Local and not persisted: it is a glance-level
  // gesture, and a collapsed tab that survived a relaunch would hide panes the
  // user has forgotten they closed the twist on.
  const [shut, setShut] = useState<Set<string>>(() => new Set())

  if (collapsed) return <PanelStrip testid="tabs-toggle" label="Tabs" side="left" onClick={onToggle} />

  const row = (pane: TabDescriptor, depth: number, last: boolean) => {
    const label = elapsedLabel(since[pane.id] ?? null, now)
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
      </div>
    )
  }

  return (
    <div
      data-testid="tabs-panel"
      className="relative flex shrink-0 flex-col border-r border-border bg-bg"
      style={{ width }}
    >
      <PanelHeading testid="tabs-heading" label="Tabs" onClick={onToggle} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {nodes.map((node) => (
          <div key={node.pane.id}>
            {node.children.length === 0 ? null : (
              <button
                data-testid={`vtwist-${node.pane.id}`}
                aria-label={shut.has(node.pane.id) ? 'Expand' : 'Collapse'}
                className="absolute cursor-default border-none bg-transparent text-faint"
                onClick={() =>
                  setShut((previous) => {
                    const next = new Set(previous)
                    if (!next.delete(node.pane.id)) next.add(node.pane.id)
                    return next
                  })
                }
              >
                {shut.has(node.pane.id) ? '▸' : '▾'}
              </button>
            )}
            {row(node.pane, 0, false)}
            {shut.has(node.pane.id)
              ? null
              : node.children.map((kid, index) => row(kid, 1, index === node.children.length - 1))}
          </div>
        ))}
      </div>
      <ColumnResizer testid="tabs-resizer" side="left" width={width} onResize={set} onCommit={commit} />
    </div>
  )
}
