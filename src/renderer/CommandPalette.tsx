import { useEffect, useState } from 'react'
import type { SkillEntry } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { filterEntries, rankFiles, rankSessions } from './lib/match'

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
  projectId,
  onSelectSession,
  onInsert,
  onOpenFile,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: PaletteSession[]
  projectCwd: string | undefined
  /** The project whose files are offered. Undefined means none are. */
  projectId: string | undefined
  onSelectSession: (id: string) => void
  onInsert: (name: string) => void
  /** A file chosen by its project-relative path. */
  onOpenFile: (relPath: string) => void
}) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [truncated, setTruncated] = useState(false)
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

  /*
   * The file list, fetched on open beside the skills above and for the same
   * reason: a file written a minute ago should be findable. Its own effect
   * rather than a second call inside that one, because it is keyed by project
   * id where skills are keyed by cwd, and one effect watching both would
   * refetch each list whenever the other's key moved.
   *
   * A failure empties the list rather than surfacing: this palette is a
   * switcher, and a project that is not a repo and cannot be walked is a
   * palette with no files in it, not an error dialog over the top of it.
   */
  useEffect(() => {
    if (!open || !projectId) return
    let cancelled = false
    window.pterm
      .projectFiles(projectId)
      .then((answer) => {
        if (cancelled) return
        setFiles(answer.files)
        setTruncated(answer.truncated)
      })
      .catch(() => {
        if (cancelled) return
        setFiles([])
        setTruncated(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectId])

  const matchedSessions = rankSessions(query, sessions)
  // Empty query shows sessions only. Every action ahead of the dozen things
  // the user switches between would bury the switcher this app is about.
  const matchedActions = query.length === 0 ? [] : filterEntries(query, skills)
  // Files join skills behind the same gate: with no query the palette is the
  // session switcher it has always been, and a thousand file rows under it
  // would bury the dozen things being switched between. Capped at 40 rows
  // because a fuzzy list past that is scrolled, not read.
  const matchedFiles = query.length === 0 ? [] : rankFiles(query, files).slice(0, 40)

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
          placeholder="Search sessions, files, then skills"
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
          {matchedFiles.map((file) => (
            <button
              key={file.path}
              data-testid={`palette-file-${file.path}`}
              onClick={() => choose(() => onOpenFile(file.path))}
              title={file.path}
              className="flex w-full cursor-default border-none bg-transparent px-1 py-1 text-left text-muted hover:bg-border hover:text-fg"
            >
              {/* Basename first and the directory after it, dimmed: the name is
                  what was typed and what is being looked for, and the path is
                  how two files of the same name are told apart. */}
              <span className="truncate">{file.name}</span>
              <span className="ml-2 flex-1 truncate text-faint">{file.path}</span>
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
          {matchedSessions.length === 0 &&
          matchedActions.length === 0 &&
          matchedFiles.length === 0 ? (
            <p data-testid="palette-empty" className="px-1 py-2 text-faint">
              Nothing matches.
            </p>
          ) : null}
          {truncated && query.length > 0 ? (
            // Said out loud rather than swallowed: past the cap this list is
            // incomplete, and a file that is missing for that reason looks
            // exactly like a file that does not exist.
            <p data-testid="palette-truncated" className="px-1 py-1 text-faint">
              Showing part of a very large project.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
