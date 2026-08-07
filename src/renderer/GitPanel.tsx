import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitChanges, GitFileChange, ProjectDescriptor } from '../shared/ipc'
import { useColumnWidth } from './lib/columnWidth'
import { ColumnResizer, PanelHeading, PanelStrip } from './ui/Panel'

/** How often the list is re-read while the column is open. */
const POLL_MS = 5000

/** The directory part of a repo-relative path, or '' for a file at the root. */
function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/** The file name part of a repo-relative path. */
function baseOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

function Row({ change }: { change: GitFileChange }) {
  const letter = change.staged ?? change.worktree ?? '?'
  const dir = dirOf(change.path)
  return (
    <div
      data-testid={`gitpanel-row-${change.path}`}
      className="flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-muted"
    >
      <span className="w-3 shrink-0 text-faint">{letter}</span>
      <span className="truncate">{baseOf(change.path)}</span>
      {dir === '' ? null : <span className="truncate text-faint">{dir}</span>}
    </div>
  )
}

/**
 * What has changed in the active project's repository.
 *
 * Polled rather than pushed, on `StatusBar`'s cadence and for its reason: the
 * working tree changes because of things happening inside terminal panes,
 * which main is never told about. Collapsed, it does not poll at all, so a
 * column nobody has opened costs nothing.
 */
export function GitPanel({
  project,
  collapsed,
  onToggle,
}: {
  project: ProjectDescriptor | undefined
  collapsed: boolean
  onToggle: () => void
}) {
  const { width, set, commit } = useColumnWidth('pterm:gitWidth')
  const [changes, setChanges] = useState<GitChanges | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Which project the state on screen belongs to. Every reply re-checks this
  // before landing, so a project switch mid-request cannot put the old
  // repository's list under the new name.
  const shown = useRef<string | undefined>(project?.id)
  useEffect(() => {
    shown.current = project?.id
    setChanges(null)
    setLoaded(false)
  }, [project?.id])

  const refresh = useCallback((): void => {
    const asked = project?.id
    if (!asked) {
      setChanges(null)
      setLoaded(true)
      return
    }
    window.pterm
      .gitChanges(asked)
      .then((next) => {
        if (shown.current !== asked) return
        setChanges(next)
        setLoaded(true)
      })
      // Swallowed like the status bar's own read: an unreadable repository is
      // a column that says so, not a startup error.
      .catch(() => {
        if (shown.current !== asked) return
        setChanges(null)
        setLoaded(true)
      })
  }, [project?.id])

  useEffect(() => {
    if (collapsed) return
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [collapsed, refresh])

  if (collapsed) {
    return <PanelStrip testid="git-toggle" label="Git" onClick={onToggle} />
  }

  const clean =
    changes !== null && changes.staged.length === 0 && changes.unstaged.length === 0

  return (
    <div
      data-testid="git-panel"
      className="relative flex shrink-0 flex-col border-l border-border bg-surface font-mono text-[11px] select-none"
      style={{ width }}
    >
      <PanelHeading testid="git-toggle" label="Git" onClick={onToggle} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {changes?.branch ? (
          <p data-testid="gitpanel-branch" className="truncate px-2.5 py-1 text-faint">
            {changes.branch}
          </p>
        ) : null}

        {loaded && changes === null ? (
          <p data-testid="gitpanel-norepo" className="px-2.5 py-1 text-faint">
            Not a git repository.
          </p>
        ) : null}

        {clean ? (
          <p data-testid="gitpanel-empty" className="px-2.5 py-1 text-faint">
            Nothing to commit.
          </p>
        ) : null}

        {changes && changes.staged.length > 0 ? (
          <>
            <p className="flex justify-between px-2.5 pt-3 pb-1 text-[10px] uppercase tracking-wider text-label">
              <span>Staged Changes</span>
              <span data-testid="gitpanel-staged-count">{changes.staged.length}</span>
            </p>
            {changes.staged.map((change) => (
              <Row key={`staged-${change.path}`} change={change} />
            ))}
          </>
        ) : null}

        {changes && changes.unstaged.length > 0 ? (
          <>
            <p className="flex justify-between px-2.5 pt-3 pb-1 text-[10px] uppercase tracking-wider text-label">
              <span>Changes</span>
              <span data-testid="gitpanel-unstaged-count">{changes.unstaged.length}</span>
            </p>
            {changes.unstaged.map((change) => (
              <Row key={`unstaged-${change.path}`} change={change} />
            ))}
          </>
        ) : null}
      </div>
      <ColumnResizer
        testid="resize-git"
        side="right"
        width={width}
        onResize={set}
        onCommit={commit}
      />
    </div>
  )
}
