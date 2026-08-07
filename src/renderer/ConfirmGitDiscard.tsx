import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { Button } from './ui/Button'

/**
 * The confirm before an irreversible discard.
 *
 * Names the files rather than counting them: "3 files" is not something a
 * person can check before clicking, and this is the last moment at which the
 * work still exists. `untracked` is called out separately because those are
 * being DELETED, not restored, and no git command will bring one back.
 */
export function ConfirmGitDiscard({
  open,
  tracked,
  untracked,
  onCancel,
  onDiscard,
}: {
  open: boolean
  tracked: string[]
  untracked: string[]
  onCancel: () => void
  onDiscard: () => void
}) {
  const total = tracked.length + untracked.length
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent data-testid="confirm-discard">
        <DialogTitle className="mb-2 text-xs uppercase tracking-wider text-faint">
          Discard {total === 1 ? 'change' : 'changes'}?
        </DialogTitle>
        {tracked.length > 0 ? (
          <div className="mb-2">
            <p className="mb-1 text-[11px] text-muted">Restored to the last commit:</p>
            <ul className="m-0 list-none p-0 font-mono text-[11px] text-fg">
              {tracked.map((path) => (
                <li key={path} className="truncate">
                  {path}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {untracked.length > 0 ? (
          <div className="mb-2">
            <p className="mb-1 text-[11px] text-danger">Deleted from disk:</p>
            <ul className="m-0 list-none p-0 font-mono text-[11px] text-fg">
              {untracked.map((path) => (
                <li key={path} className="truncate">
                  {path}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mb-3 text-[11px] text-muted">This cannot be undone.</p>
        <div className="flex justify-end gap-2">
          <Button data-testid="confirm-discard-cancel" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button data-testid="confirm-discard-go" onClick={onDiscard}>
            Discard and lose this work
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
