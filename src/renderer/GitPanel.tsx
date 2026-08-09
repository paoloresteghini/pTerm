import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DiffSide,
  GitChanges,
  GitFileChange,
  GitMutation,
  ProjectDescriptor,
} from '../shared/ipc'
import { useColumnWidth } from './lib/columnWidth'
import { createMutationGuard } from './lib/mutationGuard'
import { ColumnResizer, PanelHeading, PanelStrip, type PanelSide } from './ui/Panel'
import { ConfirmGitDiscard } from './ConfirmGitDiscard'

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
  onDiscard,
  onOpen,
}: {
  change: GitFileChange
  section: 'staged' | 'unstaged'
  busy: boolean
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onDiscard: (path: string) => void
  onOpen: (path: string, side: DiffSide) => void
}) {
  const letter = change.staged ?? change.worktree ?? '?'
  const dir = dirOf(change.path)
  return (
    <div
      data-testid={`gitpanel-${section}-${change.path}`}
      className="group flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-muted"
    >
      <span className="w-3 shrink-0 text-faint">{letter}</span>
      <button
        onClick={() => onOpen(change.path, section === 'staged' ? 'staged' : 'worktree')}
        className="flex min-w-0 flex-1 items-baseline gap-2 cursor-default border-none bg-transparent p-0 text-left text-muted hover:text-fg"
      >
        <span className="truncate">{baseOf(change.path)}</span>
        {dir === '' ? null : <span className="truncate text-faint">{dir}</span>}
      </button>
      {/* Revealed on hover so a resting list reads as file names rather than
          as a wall of controls. `group-hover` needs the `group` class above. */}
      {section === 'unstaged' ? (
        <button
          data-testid={`gitpanel-discard-${change.path}`}
          disabled={busy}
          onClick={() => onDiscard(change.path)}
          title="Discard"
          className="shrink-0 cursor-default border-none bg-transparent px-1 text-faint opacity-0 group-hover:opacity-100 hover:text-danger disabled:opacity-40"
        >
          ↺
        </button>
      ) : null}
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
 * A discard the user has been asked to confirm, frozen as the dialog opened.
 *
 * `untracked` is which of `paths` were classified as untracked THEN, not now.
 * The list behind the dialog keeps polling, so recomputing at click time would
 * rewrite the dialog's own wording under the user and hand main a
 * classification exactly as fresh as its own, which is the disagreement
 * `discard`'s fail-safe in `src/main/git/ops.ts` exists to catch.
 *
 * `projectId` is which project it was raised in, so an answer can never reach
 * a repository the dialog never named.
 */
type PendingDiscard = {
  projectId: string
  paths: string[]
  untracked: string[]
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
  onDragStart,
  onOpenDiff,
  side,
}: {
  project: ProjectDescriptor | undefined
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  onOpenDiff: (relPath: string, side: DiffSide) => void
  side: PanelSide
}) {
  const { width, set, commit } = useColumnWidth('pterm:gitWidth')
  const [changes, setChanges] = useState<GitChanges | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null)

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
    // Both of these belong to the project being left. A message typed against
    // one repository must not be committed to another, and a confirm still on
    // screen must not stay answerable once the list behind it is a different
    // repository's: ⌘1-⌘9 switches project from a window listener, so a
    // project switch with the dialog open is reachable by keyboard alone.
    setMessage('')
    setPendingDiscard(null)
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
   *
   * `onLanded` runs only for a reply that passed that same guard, so anything
   * a caller wants to do with the outcome inherits the check rather than
   * having to repeat it. Clearing the commit box is the reason it exists.
   */
  const mutate = useCallback(
    (
      call: (projectId: string) => Promise<GitMutation>,
      onLanded?: (result: GitMutation) => void,
    ): void => {
      const asked = project?.id
      if (!asked || guard.isBusy()) return
      const token = guard.started()
      setError(null)
      call(asked)
        .then((result) => {
          if (!guard.isCurrent(token)) return
          if (result.changes !== null) setChanges(result.changes)
          if (!result.ok) setError(result.error)
          onLanded?.(result)
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

  // Classified once, here, from the list the user is looking at as they ask.
  // Everything downstream reads the snapshot: see `PendingDiscard`.
  const requestDiscard = useCallback(
    (path: string) => {
      const projectId = project?.id
      if (projectId === undefined) return
      const untracked = new Set(
        (changes?.unstaged ?? []).filter((c) => c.worktree === '?').map((c) => c.path),
      )
      const paths = [path]
      setPendingDiscard({
        projectId,
        paths,
        untracked: paths.filter((p) => untracked.has(p)),
      })
    },
    [project?.id, changes],
  )

  const confirmDiscard = useCallback(() => {
    const pending = pendingDiscard
    setPendingDiscard(null)
    // The switch effect already clears a pending discard, so this can only
    // fire if some future path leaves one behind. It costs a comparison and
    // it is what makes "an answer cannot reach another repository" a property
    // of this function rather than of one effect elsewhere.
    if (pending === null || pending.projectId !== project?.id) return
    mutate((id) => window.pterm.gitDiscard(id, pending.paths, pending.untracked))
  }, [pendingDiscard, project?.id, mutate])

  // The one place that decides whether a commit may proceed: both the button
  // and the ⌘Enter key handler call this rather than duplicating its checks,
  // so the two entry points can never disagree about what is allowed. Mirrors
  // the button's own `disabled` expression exactly.
  const onCommit = useCallback((): void => {
    if (busy || message.trim() === '' || changes === null) return
    const expected = { branch: changes.branch, head: changes.head }
    const text = message
    mutate(
      (id) => window.pterm.gitCommit(id, text, expected),
      // Through `onLanded` rather than inside the `gitCommit` chain, so it
      // inherits `mutate`'s staleness check: a commit resolving after a
      // project switch would otherwise clear whatever the user has typed
      // since. Cleared only on success either way, because a refused commit
      // must not throw away the message.
      (result) => {
        if (result.ok) setMessage('')
      },
    )
  }, [busy, changes, message, mutate])

  if (collapsed) {
    return (
      <PanelStrip
        testid="git-toggle"
        label="Git"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
      />
    )
  }

  const clean =
    changes !== null && changes.staged.length === 0 && changes.unstaged.length === 0

  const pendingPaths = pendingDiscard?.paths ?? []
  const pendingUntracked = new Set(pendingDiscard?.untracked ?? [])

  return (
    <div
      data-testid="git-panel"
      className="relative flex shrink-0 flex-col border-l border-border bg-surface font-mono text-[11px] select-none"
      style={{ width }}
    >
      <PanelHeading
        testid="git-toggle"
        label="Git"
        onClick={onToggle}
        onDragStart={onDragStart}
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {/* The repository, not the project: they are the same name often
            enough that only naming one of them would read as either. A
            detached head has no branch to show, and the repository is then
            the whole line. */}
        {changes ? (
          <p className="flex gap-2 px-2.5 py-1 text-faint">
            <span data-testid="gitpanel-repo" className="truncate text-muted">
              {changes.repo}
            </span>
            {changes.branch ? (
              <span data-testid="gitpanel-branch" className="truncate">
                {changes.branch}
              </span>
            ) : null}
          </p>
        ) : null}

        <div className="flex flex-col gap-1 px-2.5 py-2">
          <textarea
            data-testid="gitpanel-message"
            // Every text field in the app carries this: without it ⌘W typed
            // into the box closes a pane and destroys its session, taking the
            // half-written message with it. ⌘Enter below is unaffected, since
            // no App binding matches `Enter`.
            data-shortcuts="off"
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
                busy={busy} onStage={onStage} onUnstage={onUnstage} onDiscard={requestDiscard}
                onOpen={onOpenDiff} />
            ))}
          </>
        ) : null}

        {changes && changes.unstaged.length > 0 ? (
          <>
            <p className="flex justify-between px-2.5 pt-3 pb-1 text-[10px] uppercase tracking-wider text-label">
              <span>Changes</span>
              <span className="flex items-center gap-2">
                <button
                  data-testid="gitpanel-stash"
                  disabled={busy}
                  onClick={() => mutate((id) => window.pterm.gitStash(id))}
                  title="Stash all changes"
                  className="cursor-default border-none bg-transparent px-1 text-faint hover:text-fg disabled:opacity-40"
                >
                  Stash
                </button>
                <span data-testid="gitpanel-unstaged-count">{changes.unstaged.length}</span>
              </span>
            </p>
            {changes.unstaged.map((change) => (
              <Row key={`unstaged-${change.path}`} change={change} section="unstaged"
                busy={busy} onStage={onStage} onUnstage={onUnstage} onDiscard={requestDiscard}
                onOpen={onOpenDiff} />
            ))}
          </>
        ) : null}
      </div>
      <ConfirmGitDiscard
        open={pendingDiscard !== null}
        tracked={pendingPaths.filter((path) => !pendingUntracked.has(path))}
        untracked={pendingPaths.filter((path) => pendingUntracked.has(path))}
        onCancel={() => setPendingDiscard(null)}
        onDiscard={confirmDiscard}
      />
      <ColumnResizer
        testid="resize-git"
        side={side}
        width={width}
        onResize={set}
        onCommit={commit}
      />
    </div>
  )
}
