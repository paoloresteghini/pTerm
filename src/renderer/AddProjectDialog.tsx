import { useEffect, useState } from 'react'
import { basename } from './lib/basename'
import type { Candidate } from '../shared/ipc'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

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
    window.pterm
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
      <DialogContent
        data-testid="add-project-dialog"
        className="flex max-h-[85vh] w-[min(560px,calc(100%-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 font-sans sm:max-w-none"
      >
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4 pr-12 text-left">
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>Choose a folder to add to your workspace.</DialogDescription>
        </DialogHeader>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? <p className="mb-2 text-sm text-destructive">{error}</p> : null}
          {candidates.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              Nothing found to suggest. Choose a folder instead.
            </p>
          ) : (
            candidates.map((candidate) => (
              <button
                key={candidate.cwd}
                data-testid={`candidate-${candidate.name}`}
                type="button"
                onClick={() => add(candidate.cwd)}
                className="flex w-full cursor-default items-baseline gap-3 rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <span className="flex-1 truncate">{candidate.name}</span>
                <span className="text-xs text-muted-foreground">{candidate.markers.join(' ')}</span>
              </button>
            ))
          )}
        </div>

        <div className="shrink-0 border-t border-border px-6 py-4">
          <Button
            data-testid="choose-folder"
            variant="outline"
            onClick={() => {
              void window.pterm.pickFolder().then((cwd) => {
                // Null means the user cancelled the picker.
                if (cwd) add(cwd)
              })
            }}
          >
            Choose folder…
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
