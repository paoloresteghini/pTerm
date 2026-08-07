import { useEffect, useState } from 'react'
import type { HooksState } from '../../shared/ipc'
import { Button } from '../ui/Button'
import { errorMessage } from './errorMessage'

export function HooksSection() {
  const [hooks, setHooks] = useState<HooksState | null>(null)
  // Its own error, separate from the workspace-wide one: a settings file that
  // does not parse must say so here, in place of an Install button that is
  // certain to fail the moment it is pressed, rather than as a banner over
  // the whole app.
  const [hooksError, setHooksError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Read on mount: another pTerm window, or a hand edit of settings.json,
  // could have changed the file since it was last read.
  useEffect(() => {
    let cancelled = false
    window.pterm
      .hooksState()
      .then((state) => {
        if (!cancelled) setHooks(state)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setHooks(null)
          setHooksError(errorMessage(reason))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const runHooksAction = (action: () => Promise<HooksState>): void => {
    setBusy(true)
    action()
      .then((state) => {
        setHooks(state)
        setHooksError(null)
      })
      .catch((reason: unknown) => setHooksError(errorMessage(reason)))
      .finally(() => setBusy(false))
  }

  return (
    <section className="mb-4 border-b border-border pb-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-faint">Claude hooks</span>
        <span data-testid="hooks-status" className="text-[11px] text-muted">
          {hooks ? (hooks.installed ? 'installed' : 'not installed') : '…'}
        </span>
      </div>

      {hooksError ? (
        <p data-testid="hooks-error" className="mb-2 text-[11px] text-danger">
          {hooksError}
        </p>
      ) : null}

      {hooks ? (
        <>
          {hooks.collisions.length > 0 ? (
            <div data-testid="hooks-collisions" className="mb-2 text-[11px] text-amber-400">
              {hooks.collisions.map((collision) => (
                <p key={`${collision.event}-${collision.command}`}>
                  {collision.event} already runs {collision.command}
                </p>
              ))}
              <p className="text-faint">
                pTerm ships its own sounds off by default so they cannot double up with these.
              </p>
            </div>
          ) : null}

          <pre
            data-testid="hooks-pending"
            className="scroll-thin mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all border border-border bg-bg p-1.5 text-[10px] text-muted"
          >
            {hooks.pending}
          </pre>

          <div className="flex gap-2">
            <Button
              data-testid="hooks-install"
              disabled={busy || hooks.installed}
              onClick={() => runHooksAction(() => window.pterm.installHooks())}
            >
              Install
            </Button>
            <Button
              data-testid="hooks-uninstall"
              disabled={busy || !hooks.installed}
              onClick={() => runHooksAction(() => window.pterm.uninstallHooks())}
            >
              Uninstall
            </Button>
          </div>
        </>
      ) : !hooksError ? (
        <p className="text-[11px] text-muted">Reading ~/.claude/settings.json…</p>
      ) : null}
    </section>
  )
}
