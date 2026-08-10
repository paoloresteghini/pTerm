import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import type { TodoPriority, TodoRecord } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { Button } from './ui/Button'
import { MarkdownView } from './ui/MarkdownView'
import { ConfirmClosePane } from './ConfirmClosePane'
import { PRIORITY_DOT, PRIORITY_LABEL } from './lib/todoList'
import { historyAgo } from './lib/historyAgo'
import { cn } from './lib/cn'
import { GUTTER_TEXT, syntaxColorStyle } from './lib/syntaxColors'

/** Epoch seconds `historyAgo` takes, from the ISO strings the store writes. */
function secondsOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

/** The three levels, in the order the picker lists them. */
const LEVELS: readonly TodoPriority[] = ['high', 'medium', 'low']

/**
 * A writable markdown body, built once per mount and never rebuilt.
 *
 * Only ever mounted while its parent is in `edit` or `create` mode, so a
 * mount is always a fresh session: entering edit again, or opening a second
 * create, unmounts the previous instance and remounts this one, which is
 * what makes `value` safe to read only as the INITIAL document. Reassigning
 * it later would rebuild the view and drop whatever the user had typed.
 */
function BodyEditor({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const host = useRef<HTMLDivElement | null>(null)
  // A ref rather than a dependency: the update listener has to be part of
  // the state a view is created with, and closing over a stale `onChange`
  // would still call the RIGHT function since it only ever calls through
  // this ref, whose current value the effect below keeps fresh.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    if (host.current === null) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        // A plain newline on Enter, ahead of the `Prec.high` binding
        // `markdown()` installs for `insertNewlineContinueMarkup`.
        //
        // That command continues a markdown list by inserting the next marker
        // for you, which is right in an editor someone lives in and wrong
        // here: nothing on screen says it happened, so the ordinary way to
        // type a two-item list (`- one`, Enter, `- two`) lands the user's own
        // `- ` on top of the inserted one and writes `- - two`. Continuing to
        // insert the marker while somehow declining the user's identical
        // keystrokes is not a thing a keymap can do, so the continuation goes:
        // this is a single-purpose body field, not a document editor, and a
        // markdown list typed in full is what everyone expects to get.
        Prec.highest(keymap.of([{ key: 'Enter', run: insertNewlineAndIndent }])),
        syntaxHighlighting(syntaxColorStyle, { fallback: true }),
        EditorView.lineWrapping,
        EditorView.theme(
          {
            '&': { color: '#d4d4d8', height: '220px' },
            '.cm-scroller': {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '11px',
              overflow: 'auto',
            },
            '.cm-gutters': { backgroundColor: 'transparent', color: GUTTER_TEXT, border: 'none' },
            '&.cm-focused': { outline: 'none' },
          },
          { dark: true },
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
      ],
    })
    const created = new EditorView({ state, parent: host.current })
    return () => created.destroy()
    // Deliberately `[]`: this builds once per mount, from whatever `value`
    // the caller handed it at that moment. See the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      data-testid="todo-body-editor"
      // Same reason the title input carries this: without it, a ⌘ shortcut
      // typed while the body has focus reaches `App.tsx`'s window-level
      // handler instead of the editor, since CodeMirror's own keymap only
      // intercepts the bindings it recognises and lets everything else
      // bubble past it.
      data-shortcuts="off"
      ref={host}
      className="scroll-thin mb-3 border border-border bg-raised"
    />
  )
}

/**
 * One todo: a read view, a form for editing or creating one, and delete
 * behind a confirm.
 *
 * `todo` is both the dialog's open flag and what it shows: `null` is closed,
 * any record both opens the dialog and is what it renders. `create` is a
 * second, independent way to be open, since a new todo has no record to name
 * yet. The two are never both meaningful (`create` wins), and `TodosPanel` is
 * the one place that decides which is set.
 *
 * There is nothing to fetch: the panel already holds the whole list, so the
 * record handed in here is the same object the row was drawn from, and every
 * mutation's reply carries the new list back out through `onChanged`.
 */
export function TodoModal({
  todo,
  create,
  onClose,
  onChanged,
}: {
  todo: TodoRecord | null
  create: boolean
  onClose: () => void
  /** The new list, straight from the mutation's reply. */
  onChanged: (todos: TodoRecord[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [priority, setPriority] = useState<TodoPriority>('medium')
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The single choke point every way out of a dirty edit or create goes
  // through: Escape, an outside click, Cancel and a target change that lands
  // mid-edit all store the action they would otherwise have run immediately,
  // and `ConfirmClosePane`'s own Discard button is the only thing that runs
  // it. `null` means nothing is pending.
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)

  const mode = create ? 'create' : editing ? 'edit' : 'read'
  const open = todo !== null || create

  // A create draft is dirty the moment either box has something in it; an edit
  // is dirty when any of the three fields differs from the record handed in.
  // Read mode is never dirty, since nothing in it is typed.
  const dirty =
    mode === 'create'
      ? title.trim() !== '' || body.trim() !== ''
      : mode === 'edit'
        ? title !== (todo?.title ?? '') || body !== (todo?.body ?? '') || priority !== (todo?.priority ?? 'medium')
        : false

  /**
   * Ends the session, then hides the dialog. Both halves matter, and hiding
   * alone is the defect `IssueModal` shipped and had to fix.
   *
   * `BodyEditor` builds its view once, from the `value` it is handed at
   * mount. Hiding without clearing left `editing`, `title`, `body` and
   * `priority` holding the last session's values, so the NEXT create mounted
   * the editor from the previous todo's body while `body` state was empty
   * behind it: the visible text was not the text that would be saved.
   * Clearing on the way out means the next session mounts from state that is
   * already empty, which is the only ordering that works.
   *
   * `pendingAction` and `confirmDelete` are cleared here too. Leaving
   * `pendingAction` set would re-show the confirm whose Discard button ran
   * this, over an app with no modal behind it; leaving `confirmDelete` set
   * would open the next read view already asking to delete.
   */
  const closeNow = useCallback(() => {
    setEditing(false)
    setTitle('')
    setBody('')
    setPriority('medium')
    setMutationError(null)
    setConfirmDelete(false)
    setPendingAction(null)
    onClose()
  }, [onClose])

  // The one place Escape, an outside click and Radix's own dismissal all land:
  // `Dialog`'s `onOpenChange` fires for every one of them alike.
  const requestClose = useCallback(() => {
    if (dirty) {
      setPendingAction(() => closeNow)
      return
    }
    closeNow()
  }, [dirty, closeNow])

  // Adopts whatever target this render names. A dirty edit or create defers
  // behind the same confirm every other exit uses rather than being wiped by
  // a target change.
  const resetForTarget = useCallback(() => {
    setEditing(false)
    setMutationError(null)
    setConfirmDelete(false)
    if (create) {
      setTitle('')
      setBody('')
      setPriority('medium')
    }
  }, [create])

  const target = todo?.id ?? null
  useEffect(() => {
    if (dirty) {
      setPendingAction(() => resetForTarget)
      return
    }
    resetForTarget()
    // Keyed on the target, not on `dirty`: a keystroke must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, create, resetForTarget])

  const startEdit = useCallback(() => {
    if (todo === null) return
    setTitle(todo.title)
    setBody(todo.body)
    setPriority(todo.priority)
    setMutationError(null)
    setEditing(true)
  }, [todo])

  const submitCreate = useCallback(() => {
    if (busy || title.trim() === '') return
    setBusy(true)
    setMutationError(null)
    window.pterm
      .todosCreate({ title, body, priority })
      .then((todos) => {
        onChanged(todos)
        closeNow()
      })
      .catch(() => setMutationError('Writing the todo list failed.'))
      .finally(() => setBusy(false))
  }, [busy, title, body, priority, onChanged, closeNow])

  const submitEdit = useCallback(() => {
    if (busy || todo === null || title.trim() === '') return
    setBusy(true)
    setMutationError(null)
    window.pterm
      .todosUpdate(todo.id, { title, body, priority })
      .then((todos) => {
        onChanged(todos)
        setEditing(false)
        // Cleared for the same reason `closeNow` clears them: text left here
        // would be what the next `BodyEditor` mounts from. `startEdit` fills
        // both from the record, so a later edit does not depend on this.
        setTitle('')
        setBody('')
      })
      .catch(() => setMutationError('Writing the todo list failed.'))
      .finally(() => setBusy(false))
  }, [busy, todo, title, body, priority, onChanged])

  const submitDone = useCallback(
    (done: boolean) => {
      if (busy || todo === null) return
      setBusy(true)
      setMutationError(null)
      window.pterm
        .todosSetDone(todo.id, done)
        .then(onChanged)
        .catch(() => setMutationError('Writing the todo list failed.'))
        .finally(() => setBusy(false))
    },
    [busy, todo, onChanged],
  )

  const submitDelete = useCallback(() => {
    if (busy || todo === null) return
    setBusy(true)
    setMutationError(null)
    window.pterm
      .todosDelete(todo.id)
      .then((todos) => {
        onChanged(todos)
        closeNow()
      })
      .catch(() => setMutationError('Writing the todo list failed.'))
      .finally(() => setBusy(false))
  }, [busy, todo, onChanged, closeNow])

  // What Cancel actually does once it is allowed to run: back out of create
  // entirely, or drop back to read mode from edit. Routed through the same
  // dirty check as every other exit, since a Cancel click is just as capable
  // of throwing away typed text as Escape is.
  const cancelEditOrCreate = useCallback(() => {
    const runCancel = (): void => {
      if (mode === 'create') {
        closeNow()
        return
      }
      setEditing(false)
      setTitle('')
      setBody('')
      setPriority('medium')
      setMutationError(null)
    }
    if (dirty) {
      setPendingAction(() => runCancel)
      return
    }
    runCancel()
  }, [mode, dirty, closeNow])

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose()
        }}
      >
        <DialogContent
          data-testid="todo-modal"
          className="scroll-thin max-h-[85vh] w-[560px] max-w-[90vw] overflow-y-auto"
        >
          {/* Always rendered: Radix warns about a `DialogContent` with no
              `DialogTitle`. */}
          <DialogTitle className="mb-3 text-sm text-fg">
            {mode === 'create' ? 'New todo' : (todo?.title ?? '')}
          </DialogTitle>

          {mode === 'create' || mode === 'edit' ? (
            <>
              <input
                data-testid="todo-title-input"
                data-shortcuts="off"
                autoFocus={mode === 'create'}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Title"
                spellCheck={false}
                className="mb-2 w-full border border-border bg-transparent px-1.5 py-1 text-[11px] text-fg placeholder:text-faint focus:outline-none"
              />
              <div className="mb-2 flex items-center gap-1">
                {LEVELS.map((level) => (
                  <button
                    key={level}
                    type="button"
                    data-testid={`todo-priority-${level}`}
                    aria-pressed={priority === level}
                    onClick={() => setPriority(level)}
                    className={cn(
                      'flex cursor-default items-center gap-1.5 rounded-sm border border-border bg-transparent px-1.5 py-0.5 text-[11px] text-faint hover:text-fg',
                      priority === level && 'border-border-strong text-fg',
                    )}
                  >
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', PRIORITY_DOT[level])} />
                    {PRIORITY_LABEL[level]}
                  </button>
                ))}
              </div>
              {/* Keyed on the mode so the create form and the edit form never
                  share one editor: this element builds its view once per
                  mount, from the `body` it is handed at that moment. */}
              <BodyEditor key={mode} value={body} onChange={setBody} />
              {mutationError ? (
                <p data-testid="todo-error" className="mb-2 text-[11px] text-danger">
                  {mutationError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button data-testid="todo-cancel" variant="ghost" onClick={cancelEditOrCreate}>
                  Cancel
                </Button>
                <Button
                  data-testid="todo-save"
                  disabled={busy || title.trim() === ''}
                  onClick={mode === 'create' ? submitCreate : submitEdit}
                >
                  {mode === 'create' ? (busy ? 'Creating…' : 'Create') : busy ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </>
          ) : todo === null ? null : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-faint">
                <span
                  data-testid="todo-priority"
                  className="flex items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 text-fg"
                >
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', PRIORITY_DOT[todo.priority])} />
                  {PRIORITY_LABEL[todo.priority]}
                </span>
                <span>Updated {historyAgo(secondsOf(todo.updatedAt), Date.now())}</span>
              </div>

              {todo.body.trim() === '' ? (
                <p className="text-faint">No description.</p>
              ) : (
                <MarkdownView value={todo.body} />
              )}

              {mutationError ? (
                <p data-testid="todo-error" className="mt-2 text-[11px] text-danger">
                  {mutationError}
                </p>
              ) : null}

              {/* A block of its own rather than `ConfirmClosePane`, whose copy
                  is about unsaved edits. Delete is the one action here that
                  cannot be undone, so it asks in place of the row of actions
                  it replaces. */}
              {confirmDelete ? (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="mb-2 text-[11px] text-muted">
                    Deleting this todo throws it away for good.
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      data-testid="todo-delete-cancel"
                      variant="ghost"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Keep it
                    </Button>
                    <Button data-testid="todo-delete-confirm" disabled={busy} onClick={submitDelete}>
                      {busy ? 'Deleting…' : 'Delete'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex justify-end gap-2 border-t border-border pt-3">
                  <Button data-testid="todo-edit" variant="ghost" disabled={busy} onClick={startEdit}>
                    Edit
                  </Button>
                  <Button
                    data-testid="todo-toggle-done"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => submitDone(!todo.done)}
                  >
                    {todo.done ? 'Mark as not done' : 'Mark as done'}
                  </Button>
                  <Button
                    data-testid="todo-delete"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmClosePane
        subject="todo"
        open={pendingAction !== null}
        onCancel={() => setPendingAction(null)}
        onDiscard={() => {
          const action = pendingAction
          setPendingAction(null)
          action?.()
        }}
      />
    </>
  )
}
