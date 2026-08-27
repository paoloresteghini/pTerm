import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

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
      <DialogContent data-testid="confirm-close" className="max-w-md gap-0 overflow-hidden p-0 font-sans">
        <DialogHeader className="border-b border-border px-6 py-4 pr-12 text-left">
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            This {subject} has edits that were never saved. Closing it now throws them away.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 px-6 py-4">
          <Button data-testid="confirm-close-cancel" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button data-testid="confirm-close-discard" variant="destructive" onClick={onDiscard}>
            Close and lose my edits
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
