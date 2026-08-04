import { useEffect, useRef, useState } from 'react'
import type { ProjectDescriptor } from '../shared/ipc'
import { createNoteSaver } from './lib/noteSaver'

/** '0' when the user has expanded the panel; anything else, including absent, is collapsed. Collapsed is the default so a new column must not steal terminal width unasked. */
const COLLAPSED_KEY = 'prcli:notesCollapsed'

export function NotesPanel({ project }: { project: ProjectDescriptor | undefined }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) !== '0')
  // null is "loading": the textarea is disabled so keystrokes cannot land in a
  // note that is about to be replaced by the fetch result.
  const [text, setText] = useState<string | null>(null)
  const projectId = project?.id

  // One saver for the component's lifetime. Rejections are swallowed for the
  // same reason the skills fetch swallows them: the text is still on screen,
  // and this panel is not where transport faults get reported.
  const saver = useRef(
    createNoteSaver((id, body) => {
      window.prcli.notesWrite(id, body).catch(() => {})
    }),
  ).current

  useEffect(() => {
    if (!projectId) {
      setText(null)
      return
    }
    let cancelled = false
    setText(null)
    window.prcli
      .notesRead(projectId)
      .then((body) => {
        if (!cancelled) setText(body)
      })
      .catch(() => {
        if (!cancelled) setText('')
      })
    return () => {
      cancelled = true
      // Project switch or unmount: the pending edit carries its own project
      // id, so flushing here cannot write it under the incoming project.
      saver.flush()
    }
  }, [projectId, saver])

  const toggle = (): void => {
    setCollapsed((was) => {
      const now = !was
      if (now) localStorage.setItem(COLLAPSED_KEY, '1')
      else localStorage.setItem(COLLAPSED_KEY, '0')
      return now
    })
  }

  if (collapsed) {
    return (
      <button
        data-testid="notes-toggle"
        onClick={toggle}
        title="Show notes"
        className="w-6 shrink-0 cursor-default border-y-0 border-l border-r-0 border-solid border-border bg-surface py-3 font-mono text-[10px] uppercase tracking-wider text-faint hover:text-fg"
        style={{ writingMode: 'vertical-rl' }}
      >
        Notes
      </button>
    )
  }

  return (
    <div
      data-testid="notes-panel"
      className="flex w-64 shrink-0 flex-col border-l border-border bg-surface font-mono text-[11px] select-none"
    >
      <button
        data-testid="notes-toggle"
        onClick={toggle}
        title="Hide notes"
        className="cursor-default border-none bg-transparent px-2.5 pb-1 pt-3 text-left text-[10px] uppercase tracking-wider text-faint hover:text-fg"
      >
        Notes
      </button>
      {!project ? (
        <p data-testid="notes-empty" className="px-2.5 py-1 text-faint">
          No project selected.
        </p>
      ) : (
        <textarea
          data-testid="notes-textarea"
          // Load-bearing, same as the skills filter: without it ⌘W typed
          // mid-note closes a pane and destroys its tmux session.
          data-shortcuts="off"
          value={text ?? ''}
          disabled={text === null}
          onChange={(event) => {
            const body = event.target.value
            setText(body)
            if (projectId) saver.edit(projectId, body)
          }}
          onBlur={() => saver.flush()}
          placeholder="Notes for this project"
          spellCheck={false}
          className="scroll-thin m-2.5 mt-1 min-h-0 flex-1 resize-none border border-border bg-transparent p-1.5 text-[11px] text-fg select-text placeholder:text-faint focus:outline-none"
        />
      )}
    </div>
  )
}
