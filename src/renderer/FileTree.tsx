import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { FileEntry } from '../shared/ipc'
import { readExpanded, writeExpanded, toggled } from './lib/treeState'
import { cn } from './lib/cn'
import { PanelHeading } from './ui/Panel'

/**
 * The active project's working tree.
 *
 * Lazy: a directory's entries are fetched when it is expanded and not before,
 * so a five-client repo costs one `readdir` at launch rather than a walk. That
 * is also why the loaded entries are a flat map keyed by relative path rather
 * than a nested structure. The tree's SHAPE is the expanded set plus that map,
 * and rendering walks it top down.
 *
 * No `fs.watch`. A recursive watcher over several repos costs descriptors and
 * wakeups continuously for a tree that is idle most of the time, and macOS
 * drops events past a limit without saying so, which is a worse failure than a
 * stale tree the user can see is stale. Reloading it is a deliberate click,
 * not a prop this component takes.
 */
export function FileTree({
  projectId,
  onOpenFile,
  onToggle,
}: {
  projectId: string | undefined
  /** Collapses the column this tree fills. Owned by `FilesPanel`'s caller. */
  onToggle: () => void
  /**
   * A file row that was clicked, by its path relative to the project. A
   * directory row never reaches this: expanding one is all a directory click
   * does, and `toggle` below returns before calling it.
   */
  onOpenFile: (relPath: string) => void
}) {
  // Relative path to that directory's entries. '' is the project root.
  const [loaded, setLoaded] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // The project this component is showing right now, read fresh from inside
  // `load`'s resolved callback rather than closed over. `load` is called with
  // the project it was READ FOR, which is fixed the moment the call goes out
  // and says nothing about what is on screen by the time the reply lands.
  // Written at the top of the effect below, before that effect fires any
  // reads for the project it is switching to, so a read started for the OLD
  // project is already stale by the read count that matters: this ref, not
  // the `id` the read carries.
  const activeProject = useRef(projectId)

  const load = useCallback(
    (id: string, relPath: string) => {
      window.pterm
        .fsList(id, relPath)
        .then((entries) => {
          // The project switched while this was in flight. Five clients
          // means switching mid-read is ordinary use, not a corner case, and
          // writing a stale project's file names into the one on screen now
          // would be silent: nothing else about the sidebar says which
          // project the row you are looking at actually came from.
          if (activeProject.current !== id) return
          setLoaded((was) => ({ ...was, [relPath]: entries }))
        })
        // Swallowed like the skills fetch: a directory that will not read is a
        // row that does not open, and this panel is not where transport faults
        // get reported.
        .catch(() => {})
    },
    [],
  )

  useEffect(() => {
    activeProject.current = projectId
    if (!projectId) {
      setLoaded({})
      setExpanded(new Set())
      return
    }
    const open = readExpanded(projectId)
    setLoaded({})
    setExpanded(open)
    load(projectId, '')
    // Every directory that was open last time, so a relaunch comes back to the
    // same tree rather than to a collapsed root.
    for (const path of open) load(projectId, path)
  }, [projectId, load])

  const toggle = (entry: FileEntry, relPath: string): void => {
    if (!projectId) return
    // A file opens; only a directory expands. Returning here rather than
    // falling through is what keeps a file out of `expanded` and out of the
    // stored set with it, which is what `a file is not expandable` asserts
    // directly, after a row count alone failed to tell the two apart.
    if (!entry.dir) {
      onOpenFile(relPath)
      return
    }
    const next = toggled(expanded, relPath)
    setExpanded(next)
    writeExpanded(projectId, next)
    if (next.has(relPath) && loaded[relPath] === undefined) load(projectId, relPath)
  }

  const reload = (): void => {
    if (!projectId) return
    // Evict first, fetch second. Without this, a directory that was expanded
    // and then collapsed stays in `loaded` forever: `reload` only ever
    // fetches `''` and the currently expanded paths, so a collapsed folder's
    // stale entries survive every refresh and `toggle` shows them again
    // on the next expand without a fetch, because it only fetches when
    // `loaded[relPath]` is undefined. Dropping the collapsed keys here makes
    // that undefined again. `''` and anything still expanded is kept so the
    // rows on screen do not blank out while the fresh reads are in flight.
    setLoaded((was) => {
      const next: Record<string, FileEntry[]> = {}
      for (const [path, entries] of Object.entries(was)) {
        if (path === '' || expanded.has(path)) next[path] = entries
      }
      return next
    })
    load(projectId, '')
    for (const path of expanded) load(projectId, path)
  }

  /** One directory's rows, then each expanded child's, depth first. */
  const rows = (parent: string, depth: number): ReactNode[] =>
    (loaded[parent] ?? []).flatMap((entry) => {
      const relPath = parent === '' ? entry.name : `${parent}/${entry.name}`
      const open = expanded.has(relPath)
      return [
        <button
          key={relPath}
          data-testid={`tree-row-${relPath}`}
          onClick={() => toggle(entry, relPath)}
          // Indent by depth, in the same 10px step the sidebar's tab rows use.
          style={{ paddingLeft: `${10 + depth * 10}px` }}
          className={cn(
            'block w-full cursor-default truncate border-none bg-transparent py-0.5 pr-2.5 text-left',
            entry.dir ? 'text-muted hover:text-fg' : 'text-faint hover:text-fg',
          )}
        >
          {entry.name}
        </button>,
        ...(open ? rows(relPath, depth + 1) : []),
      ]
    })

  return (
    <>
      {/* The heading and the refresh control are siblings, not nested: a
          `<button>` inside a `<button>` is invalid HTML and the inner one's
          click would still bubble out to collapse the column. */}
      <div className="flex items-center justify-between pr-2.5">
        <PanelHeading testid="files-toggle" label="Files" onClick={onToggle} />
        <button
          data-testid="tree-refresh"
          aria-label="Refresh files"
          onClick={reload}
          className="cursor-default border-none bg-transparent p-0 text-[11px] leading-none text-faint hover:text-fg"
        >
          ↻
        </button>
      </div>
      <div
        data-testid="tree-scroll"
        // `flex-1` and the whole column's height. The old `max-h-[40%]` cap was
        // there because this list shared the sidebar with the projects list and
        // an even split starved it; in its own column there is nothing to split
        // with.
        className="scroll-thin min-h-0 flex-1 overflow-y-auto font-mono text-[11px]"
      >
        {!projectId ? (
          // Reached where the old component returned null: this now owns a
          // column of its own, and a column that renders nothing would take its
          // width and offer no way to collapse it.
          <div data-testid="tree-noproject" className="px-2.5 py-1 text-muted">
            No project selected.
          </div>
        ) : loaded[''] !== undefined && loaded[''].length === 0 ? (
          <div
            data-testid="tree-empty"
            // Gated on `!== undefined` and not on a falsy check: the root's
            // entry list is undefined while the first read is in flight AND
            // after one that failed, since `load`'s `.catch` swallows it. Only
            // an empty ARRAY is a directory that read fine and holds nothing,
            // and saying "nothing here" during a read would be wrong twice a
            // second on a slow disk.
            //
            // "Nothing to show" rather than "this folder is empty" because
            // `fsList` filters `node_modules` and friends, so a directory full
            // of ignored entries arrives here as an empty array and calling it
            // empty would be a lie the user can see through.
            //
            // `text-muted` at a measured 4.044:1 on this panel's `bg-surface`
            // (#71717a on #0c0c0e). `text-faint`, which the file rows use, is
            // 1.871:1 here and is the ratio B1 rejected for exactly this kind
            // of string. 4.5 is not demanded the way it is of the editor's
            // gutter: this background is fixed chrome the user cannot recolour,
            // so 4.044 is the worst case rather than the best of six.
            className="px-2.5 py-1 text-muted"
          >
            Nothing to show
          </div>
        ) : (
          rows('', 0)
        )}
      </div>
    </>
  )
}
