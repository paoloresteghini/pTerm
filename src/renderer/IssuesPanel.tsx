import type { ProjectDescriptor } from '../shared/ipc'
import { useColumnWidth } from './lib/columnWidth'
import { cn } from './lib/cn'
import { ColumnResizer, PanelHeading, PanelStrip, type PanelSide } from './ui/Panel'

/**
 * The Issues column: registered here as a placeholder. It draws no list and
 * fetches nothing, deliberately; the list is a later task and this one is
 * only the column's presence, its width, and its collapse behaviour, which
 * are worth reviewing on their own before anything reads `issuesList`.
 */
export function IssuesPanel({
  project,
  collapsed,
  onToggle,
  onDragStart,
  side,
}: {
  project: ProjectDescriptor | undefined
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  side: PanelSide
}) {
  const { width, set, commit } = useColumnWidth('pterm:issuesWidth', 256)

  if (collapsed) {
    return (
      <PanelStrip
        testid="issues-toggle"
        label="Issues"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
      />
    )
  }

  return (
    <div
      data-testid="issues-panel"
      className={cn(
        'relative flex shrink-0 flex-col border-border bg-surface font-mono text-[11px] select-none',
        // The seam faces the terminal either way, the same rule every panel
        // container in this row follows: a left column drawing `border-l`
        // would put its only border against the window frame.
        side === 'left' ? 'border-r' : 'border-l',
      )}
      style={{ width }}
    >
      <PanelHeading
        testid="issues-toggle"
        label="Issues"
        onClick={onToggle}
        onDragStart={onDragStart}
      />
      <div data-testid="issues-body" className="px-2.5 py-2 text-label">
        {project ? project.name : 'No project'}
      </div>
      <ColumnResizer
        testid="resize-issues"
        side={side}
        width={width}
        onResize={set}
        onCommit={commit}
      />
    </div>
  )
}
