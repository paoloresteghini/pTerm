import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { Button } from './ui/Button'

/**
 * Asks before something with unsaved edits is closed.
 *
 * Only ever opened for something already known to be dirty: checking that is
 * the caller's job, and every caller does it before passing `open`. Callers
 * are not all closing a pane, which is why `subject` exists: it is the word the
 * body copy uses for the thing holding the edits, and defaulting it to "pane"
 * would be a lie anywhere else. Cancelling and the dialog's own dismissal
 * (Escape, an outside click) are the same action, both routed through
 * `onCancel`, so there is exactly one way to back out.
 */
export function ConfirmClosePane({
  open,
  subject = 'pane',
  onCancel,
  onDiscard,
}: {
  open: boolean
  /** What the body copy calls the thing holding the edits. */
  subject?: string
  onCancel: () => void
  onDiscard: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="confirm-close">
        <DialogTitle className="mb-2 text-xs uppercase tracking-wider text-faint">
          Unsaved changes
        </DialogTitle>
        <p className="mb-3 text-[11px] text-muted">
          This {subject} has edits that were never saved. Closing it now throws them away.
        </p>
        <div className="flex justify-end gap-2">
          <Button data-testid="confirm-close-cancel" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button data-testid="confirm-close-discard" onClick={onDiscard}>
            Close and lose my edits
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
