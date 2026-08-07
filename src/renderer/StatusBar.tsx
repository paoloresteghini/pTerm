import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus } from '../shared/ipc'

/** How often the bar re-reads the checkout, in milliseconds. */
const POLL_MS = 5000

/**
 * The strip along the bottom of the window: the active project's branch on the
 * left, and what is waiting to move in either direction on the right.
 *
 * Polled rather than pushed. The branch and the commit counts change because of
 * things happening inside the panes above it — an agent committing, a `git
 * switch` typed by hand — none of which main is told about, so there is no
 * event to subscribe to.
 *
 * A tick reads local refs only and never fetches (`src/main/git/sync.ts`), so
 * the down count is as old as the last fetch, which is the last time Sync was
 * pressed. That is the same bargain VS Code makes with `git.autofetch` off, and
 * it keeps a background network call and a possible credential prompt out of a
 * timer the user did not ask for.
 *
 * Empty and still 22px tall when the project is not in a repository: a bar that
 * appeared and vanished would move everything above it each time the user
 * switched project.
 */
export function StatusBar({ projectId }: { projectId?: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Which project the answers landing right now must belong to. A switch away
  // mid-request would otherwise let the old project's reply arrive after the new
  // one's and sit there under the wrong name.
  const shown = useRef<string | undefined>(projectId)
  useEffect(() => {
    shown.current = projectId
    setStatus(null)
    setError(null)
  }, [projectId])

  const refresh = useCallback((): void => {
    const asked = projectId
    if (!asked) {
      setStatus(null)
      return
    }
    window.pterm
      .gitStatus(asked)
      .then((next) => {
        if (shown.current === asked) setStatus(next)
      })
      .catch(() => {
        if (shown.current === asked) setStatus(null)
      })
  }, [projectId])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    // Catches the common case faster than the timer does: the user leaves,
    // commits elsewhere, and comes back to a bar that is already right.
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  const sync = (): void => {
    const asked = projectId
    if (!asked || syncing) return
    setSyncing(true)
    setError(null)
    window.pterm
      .gitSync(asked)
      .then((result) => {
        if (shown.current !== asked) return
        if (!result.ok) setError(result.error)
      })
      .catch((cause: unknown) => {
        if (shown.current === asked) setError(String(cause))
      })
      .finally(() => {
        if (shown.current !== asked) return
        setSyncing(false)
        // Whether it worked or not: a sync that failed at `push` still fetched
        // and fast-forwarded, so the counts moved either way.
        refresh()
      })
  }

  // Both counts or neither: they come from one `rev-list` against the upstream,
  // and a branch without one has nothing to be counted against. No upstream
  // means no control, rather than a Sync button whose every press would fail.
  const counted = status !== null && status.behind !== null && status.ahead !== null

  return (
    <div
      data-testid="status-bar"
      className="flex h-[22px] shrink-0 items-center justify-between gap-2 border-t border-border bg-surface px-2 text-[11px] text-muted"
    >
      {status?.branch ? (
        <span data-testid="git-branch" className="flex min-w-0 items-center gap-1 truncate">
          {/* The git branch glyph, drawn rather than typed: `⎇` is missing from
              plenty of fonts and renders as a box when it is. */}
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3 shrink-0">
            <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="4" cy="3.5" r="1.75" />
              <circle cx="4" cy="12.5" r="1.75" />
              <circle cx="12" cy="3.5" r="1.75" />
              <path d="M4 5.25v5.5" />
              <path d="M12 5.25c0 3-3.4 3-5.4 4.2" />
            </g>
          </svg>
          {status.branch}
        </span>
      ) : (
        // Holds the left slot so the sync control stays in the right corner
        // rather than sliding over when there is no branch to name.
        <span />
      )}

      <span className="flex min-w-0 items-center gap-2">
        {error ? (
          // Titled as well as shown: git's reason is often longer than the
          // corner of a 22px bar, and the truncated half is rarely the useful
          // half.
          <span data-testid="git-error" title={error} className="truncate text-danger">
            {error}
          </span>
        ) : null}

        {counted ? (
          <button
            type="button"
            data-testid="git-sync"
            onClick={sync}
            disabled={syncing}
            title="Sync: fetch, fast-forward, push"
            className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-bg hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted"
          >
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className={`h-3 w-3 shrink-0 ${syncing ? 'animate-spin' : ''}`}
            >
              <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9" />
                <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9" />
                <path d="M11.9 1.7v2.4h-2.4" />
                <path d="M4.1 14.3v-2.4h2.4" />
              </g>
            </svg>
            {/* Both counts always, zeros included: a number that disappears at
                zero makes the bar's width jump and leaves the user reading an
                absence to tell "nothing waiting" from "not counted". */}
            <span data-testid="git-counts">
              {status.behind}↓ {status.ahead}↑
            </span>
          </button>
        ) : null}
      </span>
    </div>
  )
}
