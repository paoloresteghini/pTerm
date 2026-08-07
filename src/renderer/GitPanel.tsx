import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitChanges, GitFileChange, GitMutation, ProjectDescriptor } from '../shared/ipc'
import { useColumnWidth } from './lib/columnWidth'
import { createMutationGuard } from './lib/mutationGuard'
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

function Row({
  change,
  section,
  busy,
  onStage,
  onUnstage,
}: {
  change: GitFileChange
  section: 'staged' | 'unstaged'
  busy: boolean
  onStage: (path: string) => void
  onUnstage: (path: string) => void
}) {
  const letter = change.staged ?? change.worktree ?? '?'
  const dir = dirOf(change.path)
  return (
    <div
      data-testid={`gitpanel-${section}-${change.path}`}
      className="group flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-muted"
    >
      <span className="w-3 shrink-0 text-faint">{letter}</span>
      <span className="flex-1 truncate">{baseOf(change.path)}</span>
      {dir === '' ? null : <span className="truncate text-faint">{dir}</span>}
      {/* Revealed on hover so a resting list reads as file names rather than
          as a wall of controls. `group-hover` needs the `group` class above. */}
      <button
        data-testid={`gitpanel-${section === 'staged' ? 'unstage' : 'stage'}-${change.path}`}
        disabled={busy}
        onClick={() => (section === 'staged' ? onUnstage(change.path) : onStage(change.path))}
        title={section === 'staged' ? 'Unstage' : 'Stage'}
        className="shrink-0 cursor-default border-none bg-transparent px-1 text-faint opacity-0 group-hover:opacity-100 hover:text-fg disabled:opacity-40"
      >
        {section === 'staged' ? '−' : '+'}
      </button>
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  // Owns `busy` across a project switch that abandons a stage/unstage still
  // in flight: see `mutationGuard.ts` for why that needs a dedicated guard
  // rather than the mutation's own `.finally()`.
  const guard = useRef(createMutationGuard(setBusy)).current

  // Which project the state on screen belongs to. Every reply re-checks this
  // before landing, so a project switch mid-request cannot put the old
  // repository's list under the new name.
  const shown = useRef<string | undefined>(project?.id)
  useEffect(() => {
    shown.current = project?.id
    guard.projectSwitched()
    setChanges(null)
    setLoaded(false)
    setError(null)
  }, [project?.id, guard])

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

  /**
   * Run a mutation and take the list from its reply.
   *
   * Non-optimistic on purpose, following `PromptsPanel`: the reply IS the
   * list, so a refused stage leaves the row where it was instead of showing a
   * move that did not happen.
   *
   * Gated by `guard.isCurrent`, not by `shown.current === asked`: a switch
   * away and back to the same project id would make that string comparison
   * true again while this call is still the EARLIER visit's, and its (now
   * stale) reply would land as if it were fresh. The guard's generation
   * tells the two visits apart even when their project id does not.
   */
  const mutate = useCallback(
    (call: (projectId: string) => Promise<GitMutation>): void => {
      const asked = project?.id
      if (!asked || guard.isBusy()) return
      const token = guard.started()
      setError(null)
      call(asked)
        .then((result) => {
          if (!guard.isCurrent(token)) return
          if (result.changes !== null) setChanges(result.changes)
          if (!result.ok) setError(result.error)
        })
        .catch((reason: unknown) => {
          if (!guard.isCurrent(token)) return
          setError(reason instanceof Error ? reason.message : String(reason))
        })
        .finally(() => {
          guard.settled(token)
        })
    },
    [project?.id, guard],
  )

  const onStage = useCallback(
    (path: string) => mutate((id) => window.pterm.gitStage(id, [path])),
    [mutate],
  )
  const onUnstage = useCallback(
    (path: string) => mutate((id) => window.pterm.gitUnstage(id, [path])),
    [mutate],
  )

  // The one place that decides whether a commit may proceed: both the button
  // and the ⌘Enter key handler call this rather than duplicating its checks,
  // so the two entry points can never disagree about what is allowed. Mirrors
  // the button's own `disabled` expression exactly.
  const onCommit = useCallback((): void => {
    if (busy || message.trim() === '' || changes === null) return
    const expected = { branch: changes.branch, head: changes.head }
    const text = message
    mutate((id) =>
      window.pterm.gitCommit(id, text, expected).then((result) => {
        // Cleared only on success: a refused commit must not throw away the
        // message the user typed.
        if (result.ok) setMessage('')
        return result
      }),
    )
  }, [busy, changes, message, mutate])

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

        <div className="flex flex-col gap-1 px-2.5 py-2">
          <textarea
            data-testid="gitpanel-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            // ⌘Enter commits, which is what VS Code's own placeholder
            // promises and the only key this panel claims.
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.metaKey) {
                event.preventDefault()
                onCommit()
              }
            }}
            rows={2}
            placeholder="Message (⌘Enter to commit)"
            className="scroll-thin resize-none rounded border border-border bg-bg px-1.5 py-1 font-mono text-[11px] text-fg placeholder:text-faint focus:outline-none"
          />
          <button
            data-testid="gitpanel-commit"
            disabled={busy || message.trim() === '' || changes === null}
            onClick={onCommit}
            className="cursor-default rounded border border-border bg-transparent px-2 py-1 text-muted hover:text-fg disabled:opacity-40"
          >
            Commit
          </button>
        </div>

        {error ? (
          <p data-testid="gitpanel-error" title={error} className="truncate px-2.5 py-1 text-danger">
            {error}
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
              <Row key={`staged-${change.path}`} change={change} section="staged"
                busy={busy} onStage={onStage} onUnstage={onUnstage} />
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
              <Row key={`unstaged-${change.path}`} change={change} section="unstaged"
                busy={busy} onStage={onStage} onUnstage={onUnstage} />
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
