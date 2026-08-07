import { useEffect, useState } from 'react'
import type { SkillEntry } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { filterEntries, rankSessions } from './lib/match'

/** One switchable pane, flattened by `App` so this component holds no state. */
export interface PaletteSession {
  id: string
  /** As the tab bar names it, which is also what the query matches against. */
  name: string
  /** Index into `SEVERITY`, so lower is worse. The tie-break for equal scores. */
  severity: number
}

export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  projectCwd,
  onSelectSession,
  onInsert,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: PaletteSession[]
  projectCwd: string | undefined
  onSelectSession: (id: string) => void
  onInsert: (name: string) => void
}) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [query, setQuery] = useState('')

  // Fetched on open, like AddProjectDialog rescans on open: a skill written a
  // minute ago should be here.
  useEffect(() => {
    if (!open || !projectCwd) return
    let cancelled = false
    setQuery('')
    window.pterm
      .skills(projectCwd)
      .then((found) => {
        if (!cancelled) setSkills(found)
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [open, projectCwd])

  const matchedSessions = rankSessions(query, sessions)
  // Empty query shows sessions only. Every action ahead of the dozen things
  // the user switches between would bury the switcher this app is about.
  const matchedActions = query.length === 0 ? [] : filterEntries(query, skills)

  const choose = (run: () => void): void => {
    run()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="command-palette">
        <DialogTitle className="mb-2 text-xs uppercase tracking-wider text-faint">
          Go to
        </DialogTitle>
        <input
          data-testid="palette-input"
          // Same reason as the panel's filter: without this, ⌘W typed here
          // closes a pane and destroys its session.
          data-shortcuts="off"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions, then skills"
          spellCheck={false}
          className="mb-2 w-full border border-border bg-transparent px-2 py-1 text-[12px] text-fg placeholder:text-faint focus:outline-none"
        />
        <div className="scroll-thin max-h-72 overflow-y-auto text-[11px]">
          {matchedSessions.map((session) => (
            <button
              key={session.id}
              data-testid={`palette-session-${session.id}`}
              onClick={() => choose(() => onSelectSession(session.id))}
              className="flex w-full cursor-default border-none bg-transparent px-1 py-1 text-left text-muted hover:bg-border hover:text-fg"
            >
              <span className="flex-1 truncate">{session.name}</span>
            </button>
          ))}
          {matchedActions.map((entry) => (
            // Composite key for the same reason the panel uses one: `name` is
            // unique across today's entries but nothing guarantees it.
            <button
              key={`${entry.kind}:${entry.source.kind}:${entry.name}`}
              data-testid={`palette-action-${entry.name}`}
              onClick={() => choose(() => onInsert(entry.name))}
              title={entry.description}
              className="flex w-full cursor-default border-none bg-transparent px-1 py-1 text-left text-muted hover:bg-border hover:text-fg"
            >
              <span className="flex-1 truncate">/{entry.name}</span>
            </button>
          ))}
          {matchedSessions.length === 0 && matchedActions.length === 0 ? (
            <p data-testid="palette-empty" className="px-1 py-2 text-faint">
              Nothing matches.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
