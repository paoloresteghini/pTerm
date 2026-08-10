import { useEffect, useState } from 'react'
import type { IssueDetail } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { MarkdownView } from './ui/MarkdownView'
import { issueStateLabel } from './lib/issueList'
import { historyAgo } from './lib/historyAgo'

/** Epoch seconds `historyAgo` takes, from the ISO strings `gh` sends. */
function secondsOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

/**
 * One issue, full detail, read-only.
 *
 * `number` is the dialog's own open flag as well as which issue to show:
 * `null` is closed, and any other value both opens the dialog and names the
 * fetch to run. `IssuesPanel` owns that piece of state so a row click can
 * set it and the dialog can clear it back to null on close, the same split
 * `SettingsPane` uses for its own `open`/`onOpenChange` pair.
 *
 * Nothing here writes anything: no comment box, no state change, no label
 * edit. `Task 8` owns mutations, and this component fetches once per issue
 * and shows what came back.
 */
export function IssueModal({
  projectId,
  number,
  onClose,
}: {
  projectId: string
  number: number | null
  onClose: () => void
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Skipped entirely while `number` is null: a closed dialog has nothing to
  // fetch, and running this on every render would refetch on every keystroke
  // elsewhere in the app since `projectId` and `number` are the only
  // dependencies that matter. Reopening the SAME issue still refetches,
  // because closing sets `number` back to null first, so the next open is
  // always a transition into a non-null value from that shared null case.
  useEffect(() => {
    if (number === null) return
    setDetail(null)
    setError(null)
    let live = true
    window.pterm
      .issuesGet(projectId, number)
      .then((result) => {
        if (!live) return
        if (result.ok) setDetail(result.value)
        else setError(result.message)
      })
      .catch(() => {
        if (live) setError('The GitHub CLI reported an error.')
      })
    return () => {
      live = false
    }
  }, [projectId, number])

  return (
    <Dialog
      open={number !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        data-testid="issue-modal"
        className="scroll-thin max-h-[85vh] w-[720px] max-w-[90vw] overflow-y-auto"
      >
        {/* Always rendered, even while loading or failed: Radix warns about a
            `DialogContent` with no `DialogTitle`, and the issue number is
            known from the prop before the fetch answers, so there is no
            reason to leave it blank for those two states. */}
        <DialogTitle className="mb-3 text-sm text-fg">
          <span className="text-faint">#{number}</span>
          {detail ? ` ${detail.title}` : ''}
        </DialogTitle>

        {error !== null ? (
          <p data-testid="issue-error" className="text-faint">
            {error}
          </p>
        ) : detail === null ? (
          <p data-testid="issue-loading" className="text-faint">
            …
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-faint">
              <span
                data-testid="issue-state"
                className="rounded-sm border border-border px-1.5 py-0.5 text-fg"
              >
                {issueStateLabel(detail.state, detail.stateReason)}
              </span>
              <span>
                {detail.author.login} opened this {historyAgo(secondsOf(detail.createdAt), Date.now())}
              </span>
              <button
                type="button"
                data-testid="issue-open-external"
                // `shell.openExternal` through the IPC bridge, not a bare
                // `<a href>`: this window has no browser chrome to navigate
                // back from, and a plain link would replace the running app
                // with GitHub's page instead of opening it alongside.
                onClick={() => void window.pterm.openExternal(detail.url)}
                className="cursor-default border-none bg-transparent text-faint underline hover:text-fg"
              >
                ↗ Open on GitHub
              </button>
            </div>

            {detail.labels.length > 0 || detail.assignees.length > 0 ? (
              <div className="mb-3 flex flex-wrap items-center gap-1.5 text-faint">
                {detail.labels.map((label) => (
                  <span
                    key={label.name}
                    style={{ backgroundColor: `#${label.color}` }}
                    className="rounded-sm px-1.5 py-0.5 text-[10px] text-black"
                  >
                    {label.name}
                  </span>
                ))}
                {detail.assignees.map((assignee) => (
                  <span key={assignee.login} className="text-[10px]">
                    @{assignee.login}
                  </span>
                ))}
              </div>
            ) : null}

            <MarkdownView value={detail.body} />

            {detail.comments.length > 0 ? (
              <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3">
                {detail.comments.map((comment, index) => (
                  // Comments carry no id of their own in `IssueComment`, and
                  // `gh` returns them in a fixed order this app never
                  // reorders, so the index is stable for the life of one
                  // render of this list.
                  <div key={index}>
                    <div className="mb-1 text-faint">
                      {comment.author.login} · {historyAgo(secondsOf(comment.createdAt), Date.now())}
                    </div>
                    <MarkdownView value={comment.body} />
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
