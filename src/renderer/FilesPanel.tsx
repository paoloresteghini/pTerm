import { FileTree } from './FileTree'
import { useColumnWidth } from './lib/columnWidth'
import { cn } from './lib/cn'
import { ColumnResizer, PanelStrip, type PanelSide } from './ui/Panel'

/**
 * The file tree's column. Draggable to any position in the row now, so
 * "left of the projects sidebar" is only where it starts, not where it stays.
 *
 * The tree used to sit under the projects list inside `Sidebar`, sharing that
 * column's height and capped at 40% of it so the two lists did not starve each
 * other. Its own column gives it the whole window height and a way to be given
 * up entirely, which a section wedged into someone else's column cannot have.
 *
 * The seam it draws follows `side`, like every other column: whichever edge
 * faces the terminal, not a fixed `border-r` for a position this column no
 * longer holds.
 */
export function FilesPanel({
  projectId,
  onOpenFile,
  collapsed,
  onToggle,
  onDragStart,
  side,
}: {
  projectId: string | undefined
  /** A file row clicked in the tree, by its path relative to the project. */
  onOpenFile: (relPath: string) => void
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  side: PanelSide
}) {
  // Above the collapsed return, because a hook cannot be conditional. The read
  // is cheap and the value is what the column comes back at.
  const { width, set, commit } = useColumnWidth('pterm:filesWidth')

  if (collapsed) {
    return (
      <PanelStrip
        testid="files-toggle"
        label="Files"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
      />
    )
  }

  return (
    <div
      data-testid="files-panel"
      // `relative` for the resizer, which is absolutely positioned over this
      // column's border and takes no space in the flex row.
      className={cn(
        'relative flex shrink-0 flex-col border-border bg-surface text-sm select-none',
        side === 'left' ? 'border-r' : 'border-l',
      )}
      style={{ width }}
    >
      <FileTree
        projectId={projectId}
        onOpenFile={onOpenFile}
        onToggle={onToggle}
        onDragStart={onDragStart}
      />
      <ColumnResizer
        testid="resize-files"
        side={side}
        width={width}
        onResize={set}
        onCommit={commit}
      />
    </div>
  )
}
