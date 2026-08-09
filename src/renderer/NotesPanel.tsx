import { useEffect, useRef, useState } from 'react'
import type { ProjectDescriptor } from '../shared/ipc'
import { createNoteSaver } from './lib/noteSaver'
import { useColumnWidth } from './lib/columnWidth'
import { ColumnResizer, PanelHeading, PanelStrip, type PanelSide } from './ui/Panel'

export function NotesPanel({
  project,
  collapsed,
  onToggle,
  onDragStart,
  side,
}: {
  project: ProjectDescriptor | undefined
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  side: PanelSide
}) {
  // null is "loading": the textarea is disabled so keystrokes cannot land in a
  // note that is about to be replaced by the fetch result.
  const [text, setText] = useState<string | null>(null)
  // 256, not the 208 the other columns default to: this column held `w-64`
  // before it was adjustable, and a note is prose rather than a list of names.
  const { width, set, commit } = useColumnWidth('pterm:notesWidth', 256)
  const projectId = project?.id

  // One saver for the component's lifetime. Rejections are swallowed for the
  // same reason the skills fetch swallows them: the text is still on screen,
  // and this panel is not where transport faults get reported.
  const saver = useRef(
    createNoteSaver((id, body) => {
      window.pterm.notesWrite(id, body).catch(() => {})
    }),
  ).current

  useEffect(() => {
    if (!projectId) {
      setText(null)
      return
    }
    let cancelled = false
    setText(null)
    window.pterm
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

  if (collapsed) {
    return (
      <PanelStrip
        testid="notes-toggle"
        label="Notes"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
      />
    )
  }

  return (
    <div
      data-testid="notes-panel"
      className="relative flex shrink-0 flex-col border-l border-border bg-surface font-mono text-[11px] select-none"
      style={{ width }}
    >
      <PanelHeading
        testid="notes-toggle"
        label="Notes"
        onClick={onToggle}
        onDragStart={onDragStart}
      />
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
      <ColumnResizer
        testid="resize-notes"
        side={side}
        width={width}
        onResize={set}
        onCommit={commit}
      />
    </div>
  )
}
