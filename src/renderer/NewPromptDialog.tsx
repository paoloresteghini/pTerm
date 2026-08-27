import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

/**
 * Writes one saved prompt. The same Radix dialog the ⌘K palette and the
 * add-project picker use, so it dismisses on Escape and on a click outside
 * without this file owning either rule.
 *
 * Saving is refused for an empty label or an empty body rather than being
 * allowed to write a row nothing can identify or a prompt that types nothing.
 * The refusal is the disabled button, not an error message: there is nothing
 * to explain that the two empty boxes do not already say.
 */
export function NewPromptDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Writes the prompt. The PROMISE is the contract: this dialog closes when it
   * resolves and stays open, holding the text, when it does not. A
   * fire-and-forget version of this shipped first and a failed write was
   * indistinguishable from a successful one, which is how a save against a
   * main process with no handler registered for the channel looked like
   * nothing happening at all.
   */
  onSave: (label: string, body: string) => Promise<void>
}) {
  const [label, setLabel] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Disables the button for the round trip, so a double click cannot write the
  // same prompt twice.
  const [saving, setSaving] = useState(false)

  // Cleared on open, not on close: a dialog that reopens holding the last
  // prompt's text would invite saving it twice, and clearing on close would
  // wipe the boxes under a user who dismissed by accident and reopened.
  useEffect(() => {
    if (!open) return
    setLabel('')
    setBody('')
    setError(null)
    setSaving(false)
  }, [open])

  const ready = label.trim().length > 0 && body.trim().length > 0 && !saving

  const save = (): void => {
    if (!ready) return
    setSaving(true)
    setError(null)
    onSave(label.trim(), body.trim())
      .then(() => onOpenChange(false))
      .catch((reason: unknown) => {
        // Kept open with the text still in the boxes: the alternative is
        // closing on a write that did not happen, which is the bug this
        // replaced.
        setSaving(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="prompts-dialog"
        className="flex max-h-[85vh] w-[min(640px,calc(100%-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 font-sans sm:max-w-none"
      >
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4 pr-12 text-left">
          <DialogTitle>New prompt</DialogTitle>
          <DialogDescription>Save reusable instructions for your sessions.</DialogDescription>
        </DialogHeader>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <Input
          data-testid="prompts-label"
          // Load-bearing, like the skills filter and the notes textarea:
          // without it a ⌘W typed in here closes a pane and destroys its tmux
          // session.
          data-shortcuts="off"
          autoFocus
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            // Enter moves to the body rather than saving: the label is one
            // line, the body is not, and saving from here would submit a
            // prompt whose text had not been typed yet.
            if (event.key === 'Enter') event.preventDefault()
          }}
          placeholder="Name"
          spellCheck={false}
          className="mb-3"
        />

        <Textarea
          data-testid="prompts-body"
          data-shortcuts="off"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="The prompt itself"
          spellCheck={false}
          rows={8}
          className="scroll-thin min-h-48 resize-none select-text"
        />

        {error ? (
          <p data-testid="prompts-error" className="mt-3 text-sm text-destructive">
            Not saved: {error}
          </p>
        ) : null}
        </div>

        <div className="flex shrink-0 justify-end border-t border-border px-6 py-4">
          <Button data-testid="prompts-save" disabled={!ready} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
