import { cn } from './lib/cn'

/**
 * The right-click menu on a file tree row.
 *
 * Presentational: it renders items and reports which was chosen. Every action
 * behind them belongs to `FileTree`, which owns the reload that has to follow
 * one and the inline field that two of them open.
 *
 * Positioned from the row's bounding box in viewport coordinates, and drawn
 * `fixed`, following `TabBar`'s menu. The tree scrolls, so a menu in flow
 * would be clipped by the scroller the moment a row near the bottom opened
 * one. The trade is the same one `TabBar` documents: the menu does not follow
 * its row if the list scrolls underneath it.
 *
 * None of these testids start with `tree-row-`. `filetree.spec.ts` counts rows
 * with `[data-testid^="tree-row-"]`, so anything sharing that prefix would
 * inflate the count in tests that have nothing to do with this menu.
 */
export type FileTreeAction =
  | 'open'
  | 'rename'
  | 'delete'
  | 'reveal'
  | 'copy-path'
  | 'copy-relative'
  | 'new-file'
  | 'new-folder'

export function FileTreeMenu({
  left,
  top,
  /** A directory has no Open, and its New items create inside it rather than beside it. */
  isDir,
  onChoose,
}: {
  left: number
  top: number
  isDir: boolean
  onChoose: (action: FileTreeAction) => void
}) {
  const item = (action: FileTreeAction, label: string): React.ReactNode => (
    <button
      data-testid={`treemenu-${action}`}
      // `mousedown` rather than `click`, matching the pane and tab menus: the
      // document-level listener that dismisses this menu also fires on
      // mousedown, and a menu that unmounted before the click landed would
      // swallow every choice.
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onChoose(action)
      }}
      className="block w-full cursor-default rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
    >
      {label}
    </button>
  )

  return (
    <div
      data-testid="treemenu"
      // Without this a click on the menu's own padding, rather than on an
      // item, reaches the dismiss listener and closes it — the same note
      // `TabBar` carries on its menu.
      onMouseDown={(event) => event.stopPropagation()}
      style={{ left, top }}
      className={cn(
        'fixed z-50 min-w-[160px] rounded-md border border-input bg-popover p-1 text-sm text-popover-foreground shadow-md',
      )}
    >
      {isDir ? null : item('open', 'Open')}
      {item('rename', 'Rename…')}
      {item('delete', 'Move to Trash')}
      <div className="my-1 border-t border-input" />
      {item('reveal', 'Show in Finder')}
      {item('copy-path', 'Copy path')}
      {item('copy-relative', 'Copy relative path')}
      <div className="my-1 border-t border-input" />
      {item('new-file', 'New file…')}
      {item('new-folder', 'New folder…')}
    </div>
  )
}
