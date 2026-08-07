import { FileTree } from './FileTree'
import { useColumnWidth } from './lib/columnWidth'
import { ColumnResizer, PanelStrip } from './ui/Panel'

/**
 * The file tree's column, left of the projects sidebar.
 *
 * The tree used to sit under the projects list inside `Sidebar`, sharing that
 * column's height and capped at 40% of it so the two lists did not starve each
 * other. Its own column gives it the whole window height and a way to be given
 * up entirely, which a section wedged into someone else's column cannot have.
 *
 * `border-r`, and placed before the sidebar in the flex row: this is the
 * leftmost column, so the seam it draws is on its right like the sidebar's.
 */
export function FilesPanel({
  projectId,
  onOpenFile,
  collapsed,
  onToggle,
}: {
  projectId: string | undefined
  /** A file row clicked in the tree, by its path relative to the project. */
  onOpenFile: (relPath: string) => void
  collapsed: boolean
  onToggle: () => void
}) {
  // Above the collapsed return, because a hook cannot be conditional. The read
  // is cheap and the value is what the column comes back at.
  const { width, set, commit } = useColumnWidth('pterm:filesWidth')

  if (collapsed) {
    return <PanelStrip testid="files-toggle" label="Files" side="left" onClick={onToggle} />
  }

  return (
    <div
      data-testid="files-panel"
      // `relative` for the resizer, which is absolutely positioned over this
      // column's right border and takes no space in the flex row.
      className="relative flex shrink-0 flex-col border-r border-border bg-surface font-mono text-[11px] select-none"
      style={{ width }}
    >
      <FileTree projectId={projectId} onOpenFile={onOpenFile} onToggle={onToggle} />
      <ColumnResizer
        testid="resize-files"
        side="left"
        width={width}
        onResize={set}
        onCommit={commit}
      />
    </div>
  )
}
