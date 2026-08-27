import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Plus, X } from 'lucide-react'
import type { PromptEntry } from '../shared/ipc'
import { useColumnWidth } from './lib/columnWidth'
import { cn } from './lib/cn'
import { ColumnResizer, PanelHeading, PanelStrip, PanelSurface, type PanelSide } from './ui/Panel'
import { NewPromptDialog } from './NewPromptDialog'

/**
 * The prompts the user keeps and reuses, global to the app.
 *
 * Clicking one types it into the active pane and stops there, exactly like the
 * skills list: nothing is submitted, so a prompt can be edited before it runs.
 * That is a deliberate repeat of `SkillsPanel`'s rule rather than a coincidence:
 * two lists that put text in a pane should not disagree about whether the
 * text runs.
 *
 * The list is main's, not this component's: every mutation resolves to the
 * whole list as written, and that reply replaces the state. Nothing here
 * predicts what the file will say.
 */
export function PromptsPanel({
  onInsert,
  canInsert,
  collapsed,
  onToggle,
  onDragStart,
  side,
  embedded = false,
}: {
  /** Types a prompt's body into the active pane. Never submits it. */
  onInsert: (body: string) => void
  /** False when there is no pane to type into, which disables the rows. */
  canInsert: boolean
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  side: PanelSide
  /** Renders beneath Environment in Workspace Light instead of in the row. */
  embedded?: boolean
}) {
  // null is "still reading", which renders as an ellipsis rather than as the
  // empty-state text: "no prompts yet" during the first read would be wrong on
  // every launch that has some.
  const [prompts, setPrompts] = useState<PromptEntry[] | null>(null)
  const [adding, setAdding] = useState(false)
  // A delete that did not happen. The add path reports inside the dialog,
  // which stays open; a delete has no dialog to report in, so it says so here
  // rather than leaving a row that looks deleted-but-is-not on the next launch.
  const [error, setError] = useState<string | null>(null)
  const { width, set, commit } = useColumnWidth('pterm:promptsWidth')

  // Mounting is the column opening, so this reads on every expand. Prompts are
  // global and another window may have added one.
  useEffect(() => {
    let cancelled = false
    window.pterm
      .promptsList()
      .then((found) => {
        if (!cancelled) setPrompts(found)
      })
      // Swallowed like the skills fetch: an empty list is the honest render of
      // a transport fault, and this panel is not where one gets reported.
      .catch(() => {
        if (!cancelled) setPrompts([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (collapsed) {
    return (
      <PanelStrip
        testid="prompts-toggle"
        label="Prompts"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
        embedded={embedded}
      />
    )
  }

  return (
    <PanelSurface
      data-testid="prompts-panel"
      embedded={embedded}
      side={side}
      className={cn(
        'utility-panel utility-panel-prompts select-none',
      )}
      style={embedded ? undefined : { width }}
    >
      {/* Heading and `+` as siblings: a button inside a button is invalid HTML
          and the inner click would bubble out and collapse the column. */}
      <div className="flex items-center justify-between pr-2.5">
        <PanelHeading
          testid="prompts-toggle"
          label="Prompts"
          onClick={onToggle}
          onDragStart={onDragStart}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="prompts-new"
          aria-label="New prompt"
          onClick={() => setAdding(true)}
          className="utility-add mr-1.5 cursor-default text-muted hover:text-fg"
        >
          <Plus />
        </Button>
      </div>

      <div data-testid="scroll-prompts" className="utility-list scroll-thin min-h-0 flex-1 overflow-y-auto">
        {prompts === null ? (
          <p className="utility-empty px-2.5 py-1 text-faint">…</p>
        ) : prompts.length === 0 ? (
          <p data-testid="prompts-empty" className="utility-empty px-2.5 py-1 text-muted">
            No prompts yet. Add one with +.
          </p>
        ) : (
          prompts.map((prompt) => (
            <div key={prompt.id} className="utility-prompt-row group flex items-baseline gap-1 pr-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid={`prompt-${prompt.id}`}
                disabled={!canInsert}
                onClick={() => onInsert(prompt.body)}
                // The body, so a one-word label is still identifiable without
                // opening anything.
                title={prompt.body}
                className="utility-row flex-1 justify-start cursor-default truncate border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
              >
                {prompt.label}
              </Button>
              {/* `pdelete-`, not `prompt-delete-`: `[data-testid^="prompt-"]`
                  counts the rows in this list, and a delete button under that
                  prefix would be counted as a second prompt. */}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid={`pdelete-${prompt.id}`}
                aria-label={`Delete ${prompt.label}`}
                onClick={() => {
                  // Optimism would be wrong here: the reply IS the file, and a
                  // failed delete must leave the row on screen.
                  setError(null)
                  window.pterm
                    .promptsRemove(prompt.id)
                    .then(setPrompts)
                    .catch((reason: unknown) => {
                      setError(reason instanceof Error ? reason.message : String(reason))
                    })
                }}
                className="utility-delete cursor-default text-faint hover:text-danger"
              >
                <X />
              </Button>
            </div>
          ))
        )}
      </div>

      {error ? (
        <p data-testid="prompts-error" className="px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}

      {/* Returned, not swallowed. The dialog closes on the resolve and stays
          open on the reject, so a write that did not happen cannot look like
          one that did. */}
      <NewPromptDialog
        open={adding}
        onOpenChange={setAdding}
        onSave={(label, body) => window.pterm.promptsAdd(label, body).then(setPrompts)}
      />
      {!embedded ? (
        <ColumnResizer
          testid="resize-prompts"
          side={side}
          width={width}
          onResize={set}
          onCommit={commit}
        />
      ) : null}
    </PanelSurface>
  )
}
