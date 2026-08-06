import { useEffect, useState } from 'react'
import type {
  HooksState,
  NotificationConfig,
  Rule,
  ShellHistoryState,
  TabState,
  UpdateCheckResult,
} from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { Button } from './ui/Button'
import { globalRuleOf, setGlobalRule } from './globalRule'
import { updateResultText } from './lib/updateResultText'

const STATES: TabState[] = ['waiting', 'crashed', 'idle', 'thinking', 'running', 'ended']
const SOUNDS = ['', 'Funk', 'Glass', 'Basso', 'Ping', 'Submarine']

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function SettingsPane({
  open,
  onOpenChange,
  notifications,
  onNotificationsChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  notifications: NotificationConfig | null
  onNotificationsChange: (config: NotificationConfig) => void
}) {
  const [hooks, setHooks] = useState<HooksState | null>(null)
  // Its own error, separate from the workspace-wide one: a settings file that
  // does not parse must say so here, in place of an Install button that is
  // certain to fail the moment it is pressed, rather than as a banner over
  // the whole app.
  const [hooksError, setHooksError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shellHistory, setShellHistory] = useState<ShellHistoryState | null>(null)
  // Its own error, separate from hooksError above and notifError below: a
  // rc file this app cannot read (permissions, say) must say so here rather
  // than under an Install button that only this row owns.
  const [shellHistoryError, setShellHistoryError] = useState<string | null>(null)
  const [shellBusy, setShellBusy] = useState(false)
  // Its own error, separate from the hooks one above: a failed notification
  // write must say so rather than leaving an unhandled rejection and a
  // checkbox that silently reverts the next time this pane opens.
  const [notifError, setNotifError] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [skippedVersion, setSkippedVersion] = useState<string | null>(null)

  useEffect(() => {
    // Unlike the hooks read just below, this swallows its error rather than
    // surfacing one: the version is decoration next to a dialog that already
    // works, not something the user asked for, so a failed read just leaves
    // the ellipsis in place instead of needing a place to show an error.
    window.prcli
      .appVersion()
      .then(setVersion)
      .catch(() => undefined)
  }, [])

  // Shared by the effect just below and the Skip button further down, so a
  // successful Skip updates the result line without the user closing and
  // reopening the dialog.
  const refreshSkipped = (): void => {
    window.prcli
      .skippedVersion()
      .then(setSkippedVersion)
      .catch(() => undefined)
  }

  // Refetched every time the pane opens, like `hooksState` just below: another
  // PRCLI window's Skip button, or a hand edit of update.json, could have
  // changed what is skipped since this pane last read it.
  useEffect(() => {
    if (!open) return
    refreshSkipped()
  }, [open])

  // Refetched every time the pane opens: another PRCLI window, or a hand
  // edit, could have changed either file since it was last read. Both reads
  // share this one effect and its `cancelled` flag, but keep separate state
  // and error variables: settings.json and the rc file fail independently of
  // each other, and one row going red must not blank out the other.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setHooksError(null)
    window.prcli
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
    setShellHistoryError(null)
    window.prcli
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
  }, [open])

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

  const updateRule = (state: TabState, patch: Partial<Rule>): void => {
    if (!notifications) return
    const rules = setGlobalRule(notifications.rules, state, patch)
    window.prcli
      .updateNotifications({ rules })
      .then((config) => {
        setNotifError(null)
        onNotificationsChange(config)
      })
      .catch((reason: unknown) => setNotifError(errorMessage(reason)))
  }

  const toggleMuteWhenFocused = (): void => {
    if (!notifications) return
    window.prcli
      .updateNotifications({ muteWhenFocused: !notifications.muteWhenFocused })
      .then((config) => {
        setNotifError(null)
        onNotificationsChange(config)
      })
      .catch((reason: unknown) => setNotifError(errorMessage(reason)))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="settings-pane">
        <DialogTitle className="mb-3 text-xs uppercase tracking-wider text-faint">
          Settings
        </DialogTitle>

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
                    PRCLI ships its own sounds off by default so they cannot double up with these.
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
                  onClick={() => runHooksAction(() => window.prcli.installHooks())}
                >
                  Install
                </Button>
                <Button
                  data-testid="hooks-uninstall"
                  disabled={busy || !hooks.installed}
                  onClick={() => runHooksAction(() => window.prcli.uninstallHooks())}
                >
                  Uninstall
                </Button>
              </div>
            </>
          ) : !hooksError ? (
            <p className="text-[11px] text-muted">Reading ~/.claude/settings.json…</p>
          ) : null}
        </section>

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
                  onClick={() => runShellHistoryAction(() => window.prcli.installShellHistory())}
                >
                  Install
                </Button>
                <Button
                  data-testid="shell-history-uninstall"
                  disabled={shellBusy || !shellHistory.installed}
                  onClick={() => runShellHistoryAction(() => window.prcli.uninstallShellHistory())}
                >
                  Uninstall
                </Button>
              </div>
            </>
          ) : !shellHistoryError ? (
            <p className="text-[11px] text-muted">Reading shell config…</p>
          ) : null}
        </section>

        <section>
          <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">
            Notifications
          </div>
          {notifError ? (
            <p data-testid="notifications-error" className="mb-2 text-[11px] text-danger">
              {notifError}
            </p>
          ) : null}
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-faint">
                <th className="pb-1 text-left font-normal">State</th>
                <th className="pb-1 text-left font-normal">Toast</th>
                <th className="pb-1 text-left font-normal">Sound</th>
                <th className="pb-1 text-left font-normal">Urgency</th>
              </tr>
            </thead>
            <tbody>
              {STATES.map((state) => {
                const rule = notifications ? globalRuleOf(notifications.rules, state) : undefined
                return (
                  <tr key={state}>
                    <td className="py-1 pr-2 text-muted">{state}</td>
                    <td className="pr-2">
                      <input
                        type="checkbox"
                        data-testid={`rule-toast-${state}`}
                        aria-label={`Toast on ${state}`}
                        checked={rule?.toast ?? false}
                        disabled={!notifications}
                        onChange={(event) => updateRule(state, { toast: event.target.checked })}
                      />
                    </td>
                    <td className="pr-2">
                      <select
                        data-testid={`rule-sound-${state}`}
                        aria-label={`Sound on ${state}`}
                        value={rule?.sound ?? ''}
                        disabled={!notifications}
                        onChange={(event) => updateRule(state, { sound: event.target.value || null })}
                        className="cursor-default border border-border bg-bg text-[10px] text-muted"
                      >
                        {SOUNDS.map((sound) => (
                          <option key={sound || 'none'} value={sound}>
                            {sound || '(none)'}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        data-testid={`rule-urgency-${state}`}
                        aria-label={`Urgency on ${state}`}
                        value={rule?.urgency ?? 'low'}
                        disabled={!notifications}
                        onChange={(event) =>
                          updateRule(state, { urgency: event.target.value === 'high' ? 'high' : 'low' })
                        }
                        className="cursor-default border border-border bg-bg text-[10px] text-muted"
                      >
                        <option value="low">low</option>
                        <option value="high">high</option>
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <label className="mt-3 flex items-center gap-2 text-[11px] text-muted">
            <input
              type="checkbox"
              data-testid="mute-when-focused"
              checked={notifications?.muteWhenFocused ?? false}
              disabled={!notifications}
              onChange={toggleMuteWhenFocused}
            />
            Mute toasts for the tab you are already looking at
          </label>
        </section>

        <section className="mb-4 border-b border-border pb-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-faint">Updates</span>
            <span data-testid="update-current-version" className="text-[11px] text-muted">
              {version ?? '…'}
            </span>
          </div>

          {/* The one place an update failure is visible. Everywhere else a
              failed check is silent by design; here the user pressed a button,
              and a button that answers nothing reads as broken. */}
          {updateResult ? (
            <p data-testid="update-check-result" className="mb-2 text-[11px] text-muted">
              {updateResultText(updateResult, skippedVersion)}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button
              data-testid="update-check-now"
              disabled={checking}
              onClick={() => {
                setChecking(true)
                window.prcli
                  .checkForUpdate()
                  .then(setUpdateResult)
                  .catch((reason: unknown) =>
                    setUpdateResult({
                      status: 'failed',
                      info: null,
                      message: errorMessage(reason),
                    }),
                  )
                  .finally(() => setChecking(false))
              }}
            >
              {checking ? 'Checking…' : 'Check now'}
            </Button>

            {/* Only a successful check with a release to open has anywhere
                to send this: `current` and `failed` both leave `info` null,
                and a button with nothing behind it is worse than no button. */}
            {updateResult?.info ? (
              <Button
                data-testid="update-download-settings"
                onClick={() => void window.prcli.openExternal(updateResult.info!.url)}
              >
                Download
              </Button>
            ) : null}

            {/* Same condition as Download: nothing to skip without a named
                release. Settings' own check always ignores a skip (see
                `register.ts`), so this button silences only the bar; the
                "(skipped)" suffix above is what makes that visible here. */}
            {updateResult?.info ? (
              <Button
                data-testid="update-skip-settings"
                onClick={() => {
                  void window.prcli.skipUpdate(updateResult.info!.version).then(refreshSkipped)
                }}
              >
                Skip this version
              </Button>
            ) : null}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}
