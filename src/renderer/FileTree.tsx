import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { FileEntry } from '../shared/ipc'
import { readExpanded, writeExpanded, toggled } from './lib/treeState'
import { cn } from './lib/cn'

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
export function FileTree({ projectId }: { projectId: string | undefined }) {
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
      window.prcli
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
    if (!entry.dir || !projectId) return
    const next = toggled(expanded, relPath)
    setExpanded(next)
    writeExpanded(projectId, next)
    if (next.has(relPath) && loaded[relPath] === undefined) load(projectId, relPath)
  }

  if (!projectId) return null

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
      <div className="flex items-center justify-between px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        <span>Files</span>
      </div>
      <div
        data-testid="tree-scroll"
        className="scroll-thin min-h-0 flex-1 overflow-y-auto font-mono text-[11px]"
      >
        {rows('', 0)}
      </div>
    </>
  )
}
