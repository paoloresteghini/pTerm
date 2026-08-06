import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { Button } from './ui/Button'

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
      <DialogContent data-testid="prompts-dialog">
        <DialogTitle className="mb-2 text-xs uppercase tracking-wider text-label">
          New prompt
        </DialogTitle>

        <input
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
          className="mb-2 w-full border border-border bg-transparent px-1.5 py-1 text-[11px] text-fg placeholder:text-faint focus:outline-none"
        />

        <textarea
          data-testid="prompts-body"
          data-shortcuts="off"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="The prompt itself"
          spellCheck={false}
          rows={8}
          className="scroll-thin mb-3 w-full resize-none border border-border bg-transparent p-1.5 text-[11px] text-fg select-text placeholder:text-faint focus:outline-none"
        />

        {error ? (
          <p data-testid="prompts-error" className="mb-2 text-[11px] text-danger">
            Not saved: {error}
          </p>
        ) : null}

        <Button data-testid="prompts-save" disabled={!ready} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
