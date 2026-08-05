import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { Button } from './ui/Button'

/**
 * Asks before a pane with unsaved edits is closed.
 *
 * Only ever shown for a dirty pane: `App.tsx` opens it from `requestClosePane`,
 * which checks the dirty map before this component exists. Cancelling and the
 * dialog's own dismissal (Escape, an outside click) are the same action, both
 * routed through `onCancel`, so there is exactly one way to back out.
 */
export function ConfirmClosePane({
  open,
  onCancel,
  onDiscard,
}: {
  open: boolean
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
          This pane has edits that were never saved. Closing it now throws them away.
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
