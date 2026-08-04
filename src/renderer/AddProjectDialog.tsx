import { useEffect, useState } from 'react'
import { basename } from './lib/basename'
import type { Candidate } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { Button } from './ui/Button'

export function AddProjectDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (input: { name: string; cwd: string }) => void
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [error, setError] = useState<string | null>(null)

  // Rescanned every time it opens: folders appear and disappear between uses.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    window.prcli
      .scanCandidates()
      .then((found) => {
        if (!cancelled) setCandidates(found)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const add = (cwd: string): void => {
    onAdd({ name: basename(cwd), cwd })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-project-dialog">
        <DialogTitle className="mb-2 text-xs uppercase tracking-wider text-faint">
          Add project
        </DialogTitle>

        {error ? <p className="mb-2 text-[11px] text-danger">{error}</p> : null}

        <div className="scroll-thin mb-3 max-h-72 overflow-y-auto text-[11px]">
          {candidates.length === 0 ? (
            <p className="py-2 text-muted">
              Nothing found to suggest. Choose a folder instead.
            </p>
          ) : (
            candidates.map((candidate) => (
              <button
                key={candidate.cwd}
                data-testid={`candidate-${candidate.name}`}
                onClick={() => add(candidate.cwd)}
                className="flex w-full cursor-default items-baseline gap-2 border-none bg-transparent px-1 py-1 text-left text-muted hover:bg-border hover:text-fg"
              >
                <span className="flex-1 truncate">{candidate.name}</span>
                <span className="text-faint">{candidate.markers.join(' ')}</span>
              </button>
            ))
          )}
        </div>

        <Button
          data-testid="choose-folder"
          onClick={() => {
            void window.prcli.pickFolder().then((cwd) => {
              // Null means the user cancelled the picker.
              if (cwd) add(cwd)
            })
          }}
        >
          Choose folder…
        </Button>
      </DialogContent>
    </Dialog>
  )
}
