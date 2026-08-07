import { useEffect, useState } from 'react'
import type { UpdateCheckResult } from '../../shared/ipc'
import { Button } from '../ui/Button'
import { errorMessage } from './errorMessage'
import { updateResultText } from '../lib/updateResultText'

export function UpdatesSection() {
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [skippedVersion, setSkippedVersion] = useState<string | null>(null)

  // Shared by the effect just below and the Skip button further down, so a
  // successful Skip updates the result line without the user closing and
  // reopening the dialog.
  const refreshSkipped = (): void => {
    window.pterm
      .skippedVersion()
      .then(setSkippedVersion)
      .catch(() => undefined)
  }

  // Read on mount: another pTerm window's Skip button, or a hand edit of
  // update.json, could have changed what is skipped since it was last read.
  useEffect(() => {
    refreshSkipped()
  }, [])

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-label">Updates</span>
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
            window.pterm
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
            onClick={() => void window.pterm.openExternal(updateResult.info!.url)}
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
              void window.pterm.skipUpdate(updateResult.info!.version).then(refreshSkipped)
            }}
          >
            Skip this version
          </Button>
        ) : null}
      </div>
    </section>
  )
}
