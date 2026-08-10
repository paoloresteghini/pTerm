import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import type { IssueDetail } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { Button } from './ui/Button'
import { MarkdownView } from './ui/MarkdownView'
import { ConfirmClosePane } from './ConfirmClosePane'
import { issueStateLabel } from './lib/issueList'
import { historyAgo } from './lib/historyAgo'
import { GUTTER_TEXT, syntaxColorStyle } from './lib/syntaxColors'

/** Epoch seconds `historyAgo` takes, from the ISO strings `gh` sends. */
function secondsOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

/**
 * A writable markdown body, built once per mount and never rebuilt.
 *
 * Only ever mounted while its parent is in `edit` or `create` mode, so a
 * mount is always a fresh session: entering edit again, or opening a second
 * create, unmounts the previous instance and remounts this one, which is
 * what makes `value` safe to read only as the INITIAL document. Reassigning
 * it later would rebuild the view and drop whatever the user had typed,
 * exactly the trap `FileView.tsx` documents at its own build effect.
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
        // That command continues a markdown list by inserting the next
        // marker for you, which is right in an editor someone lives in and
        // wrong here: nothing on screen says it happened, so the ordinary way
        // to type a two-item list (`- one`, Enter, `- two`) lands the user's
        // own `- ` on top of the inserted one and writes `- - two`. It filed a
        // real malformed issue during live testing. Continuing to insert the
        // marker while somehow declining the user's identical keystrokes is
        // not a thing a keymap can do, so the continuation goes: this is a
        // single-purpose issue-body field, not a document editor, and a
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
      data-testid="issue-body-editor"
      // Same reason the title input and the comment box carry this: without
      // it, a ⌘ shortcut typed while the body has focus (⌘+digit to switch
      // the active project among them) reaches `App.tsx`'s window-level
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
 * One issue: read-only detail, or a title-and-body form for editing or
 * creating one, plus the comment box and the close/reopen actions.
 *
 * `number` is the dialog's own open flag as well as which issue to show, the
 * same split `SettingsPane`'s caller uses for its own `open`/`onOpenChange`
 * pair: `null` is closed, and any other value both opens the dialog and
 * names the fetch to run. `create` is a second, independent way to be open:
 * the panel's `+` sets it with `number` still `null`, since there is no
 * issue yet to name. The two are never both meaningful at once (`create`
 * wins when it is true), and `IssuesPanel` is the one place that decides
 * which of them is set.
 *
 * Every mutation here is pessimistic: a submit disables its button and shows
 * a spinner while in flight, and only touches what is on screen once the
 * reply lands. A list that briefly claimed an issue was closed before `gh`
 * confirmed it would be a worse failure mode than the wait.
 */
export function IssueModal({
  projectId,
  projectRepo,
  number,
  create,
  onClose,
  onMutated,
}: {
  projectId: string
  /**
   * The repository the panel is showing for `projectId`, or null while it
   * does not know one. Read only in create mode, and only through the ref
   * below so it cannot pull the reset effect around: read and edit take
   * their slug from the reply that fetched the issue instead.
   */
  projectRepo: string | null
  number: number | null
  /** Opens the dialog in create mode, with no issue to fetch. */
  create: boolean
  onClose: () => void
  /** Tell the panel to refetch its list after a mutation lands. */
  onMutated: () => void
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null)
  // The repository this dialog is about, shown under the title. Without it
  // nothing on screen distinguished two repositories' issue #42, and a ⌘+digit
  // project switch with the dialog open refetches the same NUMBER against the
  // new repository and repaints in place. Frozen with the rest of the target
  // by `resetForTarget`, so it names what the buttons would actually act on.
  const [repoSlug, setRepoSlug] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  // The single choke point every way out of a dirty edit or create goes
  // through: Escape, an outside click, the Cancel button, and a target
  // change that lands mid-edit all store the action they would otherwise
  // have run immediately, and `ConfirmClosePane`'s own Discard button is
  // the only thing that actually runs it. `null` means nothing is pending.
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)

  const mode = create ? 'create' : editing ? 'edit' : 'read'
  const open = number !== null || create

  // Every reply from `fetchDetail` below carries the token it was sent
  // under; a reply whose token no longer matches the current one is from an
  // earlier call (a project or issue switch, or simply a slower request
  // overtaken by a newer one) and is dropped rather than landing.
  const fetchToken = useRef(0)

  // A ref rather than a dependency, the same reason `BodyEditor`'s
  // `onChangeRef` is one: `projectRepo` changes every time the panel's own
  // list reloads, and as a dependency of `resetForTarget` that would refetch
  // this dialog's issue each time the column behind it refreshed.
  const projectRepoRef = useRef(projectRepo)
  useEffect(() => {
    projectRepoRef.current = projectRepo
  })

  // The project and issue an in-progress edit or create actually targets,
  // frozen at the moment that session started (`resetForTarget` and
  // `startEdit` both write it, always the pair this render names).
  // `submitEdit`/`submitCreate` read this instead of the live
  // `projectId`/`number` props: if a target change lands while dirty (see
  // the effect below) the confirm blocks further submits until it is
  // answered, but a project switch by ⌘+digit can still land the instant
  // BEFORE that effect runs, and reading the live props at submit time would
  // then send an edit to a repository the user was never shown.
  const activeTarget = useRef<{ projectId: string; number: number | null }>({ projectId, number })

  // `clear` is false for a refetch after a mutation on the SAME issue: the
  // detail already on screen stays there until the fresh copy arrives,
  // rather than the modal flashing back to its loading state for a reply
  // that changed only the state chip or added one comment.
  const fetchDetail = useCallback(
    (clear: boolean) => {
      if (number === null) return
      const token = ++fetchToken.current
      if (clear) {
        setDetail(null)
        setFetchError(null)
      }
      window.pterm
        .issuesGet(projectId, number)
        .then((result) => {
          if (fetchToken.current !== token) return
          if (result.ok) {
            setDetail(result.value)
            setRepoSlug(result.repo.slug)
            setFetchError(null)
          } else {
            setFetchError(result.message)
          }
        })
        .catch(() => {
          if (fetchToken.current !== token) return
          setFetchError('The GitHub CLI reported an error.')
        })
    },
    [projectId, number],
  )

  // A create draft is dirty the moment either box has something in it; an
  // edit is dirty when either differs from the issue as it was fetched. Read
  // mode is never dirty, since nothing in it is typed. Computed before the
  // effect below, which reads it as a plain closure value rather than a
  // dependency: see that effect's own comment for why.
  const dirty =
    mode === 'create'
      ? title.trim() !== '' || body.trim() !== ''
      : mode === 'edit'
        ? title !== (detail?.title ?? '') || body !== (detail?.body ?? '')
        : false

  // Adopts whatever target this render names (a different issue, a project
  // switch, or `create` toggling on): clears the edit/create/comment state,
  // freezes `activeTarget` to match, and fetches fresh detail. Skipped
  // entirely while closed, via `fetchDetail`'s own `number === null` guard,
  // which also covers `create`.
  const resetForTarget = useCallback(() => {
    activeTarget.current = { projectId, number }
    setEditing(false)
    setMutationError(null)
    setComment('')
    // Create has no fetch to learn the repository from, so it takes the
    // panel's; every other mode clears it here and `fetchDetail` fills it in
    // from the reply, which is what makes a repaint after a project switch
    // visible rather than silent.
    setRepoSlug(create ? projectRepoRef.current : null)
    if (create) {
      setTitle('')
      setBody('')
    }
    fetchDetail(true)
  }, [projectId, number, create, fetchDetail])

  // Runs only when the TARGET actually changes (`resetForTarget`'s own
  // identity, which moves with `projectId`, `number` and `create`), never on
  // a keystroke that merely flips `dirty`. A dirty edit or create defers the
  // reset behind the same confirm every other exit uses instead of running
  // it straight away, which is what stops a target change from silently
  // discarding unsaved text: without this, a project switch by ⌘+digit
  // landing while `BodyEditor` did not have focus (nothing marked it
  // `data-shortcuts="off"` until this fix) wiped an in-progress edit with no
  // warning at all. Radix's own `modal=true` blocks a stray click reaching
  // another row or the panel's `+` while this dialog is open, but that is a
  // property of the current UI rather than a defence this component owns,
  // so the same gate covers it regardless of how a future change might
  // reach here.
  useEffect(() => {
    if (dirty) {
      setPendingAction(() => resetForTarget)
      return
    }
    resetForTarget()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetForTarget])

  const startEdit = useCallback(() => {
    if (detail === null) return
    activeTarget.current = { projectId, number }
    setTitle(detail.title)
    setBody(detail.body)
    setMutationError(null)
    setEditing(true)
  }, [detail, projectId, number])

  const closeNow = useCallback(() => {
    onClose()
  }, [onClose])

  // The one place Escape, an outside click and Radix's own dismissal all
  // land: `Dialog`'s `onOpenChange` fires for every one of them alike. A
  // dirty title or body routes through `ConfirmClosePane` instead of closing
  // immediately; its own Discard button is what actually closes from there.
  const requestClose = useCallback(() => {
    if (dirty) {
      setPendingAction(() => closeNow)
      return
    }
    closeNow()
  }, [dirty, closeNow])

  const submitCreate = useCallback(() => {
    if (busy || title.trim() === '') return
    const target = activeTarget.current
    setBusy(true)
    setMutationError(null)
    window.pterm
      .issuesCreate(target.projectId, title, body)
      .then((result) => {
        if (!result.ok) {
          setMutationError(result.message)
          return
        }
        onMutated()
        closeNow()
      })
      .catch(() => setMutationError('The GitHub CLI reported an error.'))
      .finally(() => setBusy(false))
  }, [busy, title, body, onMutated, closeNow])

  const submitEdit = useCallback(() => {
    const target = activeTarget.current
    if (busy || target.number === null || title.trim() === '') return
    setBusy(true)
    setMutationError(null)
    window.pterm
      .issuesEdit(target.projectId, target.number, title, body)
      .then((result) => {
        if (!result.ok) {
          setMutationError(result.message)
          return
        }
        setEditing(false)
        onMutated()
        fetchDetail(false)
      })
      .catch(() => setMutationError('The GitHub CLI reported an error.'))
      .finally(() => setBusy(false))
  }, [busy, title, body, onMutated, fetchDetail])

  const submitState = useCallback(
    (action: 'close' | 'reopen', reason?: 'completed' | 'not planned') => {
      if (busy || number === null) return
      setBusy(true)
      setMutationError(null)
      window.pterm
        .issuesSetState(projectId, number, action, reason)
        .then((result) => {
          if (!result.ok) {
            setMutationError(result.message)
            return
          }
          onMutated()
          fetchDetail(false)
        })
        .catch(() => setMutationError('The GitHub CLI reported an error.'))
        .finally(() => setBusy(false))
    },
    [busy, projectId, number, onMutated, fetchDetail],
  )

  const submitComment = useCallback(() => {
    if (busy || number === null || comment.trim() === '') return
    setBusy(true)
    setMutationError(null)
    window.pterm
      .issuesComment(projectId, number, comment)
      .then((result) => {
        if (!result.ok) {
          setMutationError(result.message)
          return
        }
        setComment('')
        onMutated()
        fetchDetail(false)
      })
      .catch(() => setMutationError('The GitHub CLI reported an error.'))
      .finally(() => setBusy(false))
  }, [busy, projectId, number, comment, onMutated, fetchDetail])

  // Whichever of create, edit or comment is the active action, given the
  // current mode. Bound on the modal's own keydown rather than globally, so
  // ⌘Enter typed anywhere else in the app is untouched.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'Enter' || !event.metaKey) return
      event.preventDefault()
      if (mode === 'create') submitCreate()
      else if (mode === 'edit') submitEdit()
      else submitComment()
    },
    [mode, submitCreate, submitEdit, submitComment],
  )

  // What Cancel actually does once it is allowed to run: back out of create
  // entirely, or drop back to read mode from edit. Routed through the same
  // dirty check as every other exit below, since a Cancel click is just as
  // capable of throwing away typed text as Escape is.
  const cancelEditOrCreate = useCallback(() => {
    const runCancel = (): void => {
      if (mode === 'create') {
        closeNow()
        return
      }
      setEditing(false)
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
          data-testid="issue-modal"
          onKeyDown={onKeyDown}
          className="scroll-thin max-h-[85vh] w-[720px] max-w-[90vw] overflow-y-auto"
        >
          {/* Always rendered, even while loading or failed: Radix warns about
              a `DialogContent` with no `DialogTitle`. */}
          <DialogTitle className="mb-3 text-sm text-fg">
            {mode === 'create' ? (
              'New issue'
            ) : (
              <>
                <span className="text-faint">#{number}</span>
                {detail ? ` ${detail.title}` : ''}
              </>
            )}
            {repoSlug !== null ? (
              <span data-testid="issue-repo" className="mt-0.5 block text-[11px] font-normal text-faint">
                {repoSlug}
              </span>
            ) : null}
          </DialogTitle>

          {mode === 'create' ? (
            <>
              <input
                data-testid="issue-title-input"
                data-shortcuts="off"
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Title"
                spellCheck={false}
                className="mb-2 w-full border border-border bg-transparent px-1.5 py-1 text-[11px] text-fg placeholder:text-faint focus:outline-none"
              />
              <BodyEditor value={body} onChange={setBody} />
              {mutationError ? (
                <p data-testid="issue-error" className="mb-2 text-[11px] text-danger">
                  {mutationError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button data-testid="issue-cancel" variant="ghost" onClick={cancelEditOrCreate}>
                  Cancel
                </Button>
                <Button data-testid="issue-create-submit" disabled={busy || title.trim() === ''} onClick={submitCreate}>
                  {busy ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </>
          ) : fetchError !== null ? (
            <p data-testid="issue-error" className="text-faint">
              {fetchError}
            </p>
          ) : detail === null ? (
            <p data-testid="issue-loading" className="text-faint">
              …
            </p>
          ) : (
            <>
              {mode === 'edit' ? (
                <>
                  <input
                    data-testid="issue-title-input"
                    data-shortcuts="off"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Title"
                    spellCheck={false}
                    className="mb-2 w-full border border-border bg-transparent px-1.5 py-1 text-[11px] text-fg placeholder:text-faint focus:outline-none"
                  />
                  <BodyEditor value={body} onChange={setBody} />
                </>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-faint">
                    <span
                      data-testid="issue-state"
                      className="rounded-sm border border-border px-1.5 py-0.5 text-fg"
                    >
                      {issueStateLabel(detail.state, detail.stateReason)}
                    </span>
                    <span>
                      {detail.author.login} opened this{' '}
                      {historyAgo(secondsOf(detail.createdAt), Date.now())}
                    </span>
                    <button
                      type="button"
                      data-testid="issue-open-external"
                      onClick={() => void window.pterm.openExternal(detail.url)}
                      className="cursor-default border-none bg-transparent text-faint underline hover:text-fg"
                    >
                      ↗ Open on GitHub
                    </button>
                  </div>

                  {detail.labels.length > 0 || detail.assignees.length > 0 ? (
                    <div className="mb-3 flex flex-wrap items-center gap-1.5 text-faint">
                      {detail.labels.map((label) => (
                        <span
                          key={label.name}
                          style={{ backgroundColor: `#${label.color}` }}
                          className="rounded-sm px-1.5 py-0.5 text-[10px] text-black"
                        >
                          {label.name}
                        </span>
                      ))}
                      {detail.assignees.map((assignee) => (
                        <span key={assignee.login} className="text-[10px]">
                          @{assignee.login}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <MarkdownView value={detail.body} />

                  {detail.comments.length > 0 ? (
                    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3">
                      {detail.comments.map((comment_, index) => (
                        // Comments carry no id of their own; see the same note
                        // this file kept from Task 7's read-only version.
                        <div key={index}>
                          <div className="mb-1 text-faint">
                            {comment_.author.login} ·{' '}
                            {historyAgo(secondsOf(comment_.createdAt), Date.now())}
                          </div>
                          <MarkdownView value={comment_.body} />
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-4 border-t border-border pt-3">
                    <textarea
                      data-testid="issue-comment-input"
                      data-shortcuts="off"
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="Leave a comment (⌘Enter to submit)"
                      spellCheck={false}
                      rows={3}
                      className="scroll-thin mb-2 w-full resize-none border border-border bg-transparent p-1.5 text-[11px] text-fg placeholder:text-faint focus:outline-none"
                    />
                    <div className="flex justify-end">
                      <Button
                        data-testid="issue-comment-submit"
                        disabled={busy || comment.trim() === ''}
                        onClick={submitComment}
                      >
                        {busy ? 'Commenting…' : 'Comment'}
                      </Button>
                    </div>
                  </div>
                </>
              )}

              {mutationError ? (
                <p data-testid="issue-error" className="mt-2 text-[11px] text-danger">
                  {mutationError}
                </p>
              ) : null}

              <div className="mt-3 flex justify-end gap-2 border-t border-border pt-3">
                {mode === 'edit' ? (
                  <>
                    <Button data-testid="issue-cancel" variant="ghost" onClick={cancelEditOrCreate}>
                      Cancel
                    </Button>
                    <Button data-testid="issue-save" disabled={busy || title.trim() === ''} onClick={submitEdit}>
                      {busy ? 'Saving…' : 'Save'}
                    </Button>
                  </>
                ) : detail.state === 'OPEN' ? (
                  <>
                    {/* `disabled={busy}` for the same reason the buttons beside
                        it carry it: entering edit mid-close loads the form from
                        the pre-close `detail`, and the refetch that follows the
                        close updates `detail` underneath without touching the
                        form the user is now typing into. */}
                    <Button data-testid="issue-edit" variant="ghost" disabled={busy} onClick={startEdit}>
                      Edit
                    </Button>
                    <Button
                      data-testid="issue-close-not-planned"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => submitState('close', 'not planned')}
                    >
                      {busy ? 'Closing…' : 'Close as not planned'}
                    </Button>
                    <Button
                      data-testid="issue-close-completed"
                      disabled={busy}
                      onClick={() => submitState('close', 'completed')}
                    >
                      {busy ? 'Closing…' : 'Close as completed'}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button data-testid="issue-edit" variant="ghost" disabled={busy} onClick={startEdit}>
                      Edit
                    </Button>
                    <Button data-testid="issue-reopen" disabled={busy} onClick={() => submitState('reopen')}>
                      {busy ? 'Reopening…' : 'Reopen'}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmClosePane
        subject="issue"
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
