import { useEffect, useState } from 'react'
import type { ShellHistoryState } from '../../shared/ipc'
import { Button } from '../ui/Button'
import { errorMessage } from './errorMessage'

export function ShellHistorySection() {
  const [shellHistory, setShellHistory] = useState<ShellHistoryState | null>(null)
  // Its own error, separate from the other sections': a rc file this app
  // cannot read (permissions, say) must say so here rather than under an
  // Install button that only this row owns.
  const [shellHistoryError, setShellHistoryError] = useState<string | null>(null)
  const [shellBusy, setShellBusy] = useState(false)

  // Read on mount: another pTerm window, or a hand edit of the rc file,
  // could have changed it since it was last read.
  useEffect(() => {
    let cancelled = false
    window.pterm
      .shellHistoryState()
      .then((state) => {
        if (!cancelled) setShellHistory(state)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setShellHistory(null)
          setShellHistoryError(errorMessage(reason))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const runShellHistoryAction = (action: () => Promise<ShellHistoryState>): void => {
    setShellBusy(true)
    action()
      .then((state) => {
        setShellHistory(state)
        setShellHistoryError(null)
      })
      .catch((reason: unknown) => setShellHistoryError(errorMessage(reason)))
      .finally(() => setShellBusy(false))
  }

  return (
    <section className="mb-4 border-b border-border pb-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-faint">Shell history</span>
        <span data-testid="shell-history-status" className="text-[11px] text-muted">
          {shellHistory ? (shellHistory.installed ? 'installed' : 'not installed') : '…'}
        </span>
      </div>

      {shellHistoryError ? (
        <p data-testid="shell-history-error" className="mb-2 text-[11px] text-danger">
          {shellHistoryError}
        </p>
      ) : null}

      {shellHistory ? (
        <>
          <p data-testid="shell-history-paths" className="mb-2 text-[11px] text-muted">
            Adds a line to {shellHistory.rcPath} that sources {shellHistory.scriptPath}.
          </p>

          {/* Required copy: without it, the first thing a user sees after
              installing is an empty overlay in every pane they already
              had open, which reads as the feature being broken. It is
              true because a running pane's shell already read .zshrc,
              once, before this line existed to source; only a pane
              started after this line lands sources it. */}
          <p className="mb-2 text-[11px] text-muted">
            Only takes effect in shell panes opened after you install it. Panes already open
            will not record anything until you close and reopen them.
          </p>

          {/* The consent copy. Everything above this describes what the
              install does to two files the user already knows about; this
              is the part that says a new file starts being written, what
              goes into it, how to keep one command out of it, and what
              Uninstall does not do. Written here because there is nowhere
              else: this row is the only screen in the app that mentions
              the feature at all, and the pending block below shows only
              the `source` line, so reading the exact text on offer does
              not reveal any of it either.

              The sentence about uninstalling is the one to be careful
              with, because a user reading it has usually decided they do
              NOT want to be recorded, and the paragraph above states the
              same asymmetry for install. Uninstall rewrites .zshrc and
              nothing else; a pane already running has sourced the script
              and holds pterm_history_preexec in its own
              `preexec_functions`, with PTERM_HISTORY_FILE already set as a
              shell variable. Measured 2026-08-06 against the real rendered
              script: a live interactive zsh went on recording after the
              script file was DELETED under it, which is stronger than
              uninstall, since uninstall deliberately leaves that file on
              disk. Nothing on disk can reach a shell that has already
              started. */}
          <p data-testid="shell-history-disclosure" className="mb-2 text-[11px] text-muted">
            Records every command run in shell panes to {shellHistory.historyFile}, with no
            size limit. A command typed with a leading space is not recorded. Uninstalling
            only takes effect in panes opened after it, so a pane already open keeps
            recording until you close and reopen it. The file is left behind either way, and
            nothing in this app deletes it.
          </p>

          <pre
            data-testid="shell-history-pending"
            className="scroll-thin mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all border border-border bg-bg p-1.5 text-[10px] text-muted"
          >
            {shellHistory.pending}
          </pre>

          <div className="flex gap-2">
            <Button
              data-testid="shell-history-install"
              disabled={shellBusy || shellHistory.installed}
              onClick={() => runShellHistoryAction(() => window.pterm.installShellHistory())}
            >
              Install
            </Button>
            <Button
              data-testid="shell-history-uninstall"
              disabled={shellBusy || !shellHistory.installed}
              onClick={() => runShellHistoryAction(() => window.pterm.uninstallShellHistory())}
            >
              Uninstall
            </Button>
          </div>
        </>
      ) : !shellHistoryError ? (
        <p className="text-[11px] text-muted">Reading shell config…</p>
      ) : null}
    </section>
  )
}
