import { useEffect, useState } from 'react'
import type { SkillEntry } from '../shared/ipc'
import { FileText, Sparkles, Terminal } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { filterEntries, rankFiles, rankSessions } from './lib/match'

/** One switchable pane, flattened by `App` so this component holds no state. */
export interface PaletteSession {
  id: string
  /** As the tab bar names it, which is also what the query matches against. */
  name: string
  /** Index into `SEVERITY`, so lower is worse. The tie-break for equal scores. */
  severity: number
}

/**
 * One thing the palette can DO, as opposed to something it can switch to.
 *
 * Sessions, skills and files are all things to jump to or insert; a command
 * runs `run` in `App` instead. `name` is both the label and what the query
 * matches, so it goes through the same `filterEntries` ranking as skills.
 */
export interface PaletteCommand {
  name: string
  run: () => void
}

export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  projectCwd,
  projectId,
  commands,
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
  commands: PaletteCommand[]
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
  // Commands sit behind the same gate as skills and files, for the same
  // reason: an empty query is the session switcher, not a list of things to
  // run.
  const matchedCommands = query.length === 0 ? [] : filterEntries(query, commands)
  const hasResults =
    matchedSessions.length > 0 ||
    matchedFiles.length > 0 ||
    matchedCommands.length > 0 ||
    matchedActions.length > 0

  const choose = (run: () => void): void => {
    run()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="command-palette" className="max-w-xl gap-0 overflow-hidden p-0 font-sans">
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Search for a session, file, skill, or command.</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false}>
          <CommandInput
            data-testid="palette-input"
            // Same reason as the panel's filter: without this, ⌘W typed here
            // closes a pane and destroys its session.
            data-shortcuts="off"
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search sessions, files, skills, and commands"
            spellCheck={false}
          />
          <CommandList className="scroll-thin">
            {matchedSessions.length > 0 ? (
              <CommandGroup heading={query.length === 0 ? 'Open sessions' : 'Sessions'}>
                {matchedSessions.map((session) => (
                  <CommandItem
                    key={session.id}
                    value={session.id}
                    data-testid={`palette-session-${session.id}`}
                    onSelect={() => choose(() => onSelectSession(session.id))}
                  >
                    <Terminal />
                    <span className="min-w-0 flex-1 truncate">{session.name}</span>
                    {session.severity === 0 ? <CommandShortcut>Needs attention</CommandShortcut> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {matchedFiles.length > 0 ? (
              <>
                {matchedSessions.length > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading="Files">
                  {matchedFiles.map((file) => (
                    <CommandItem
                      key={file.path}
                      value={file.path}
                      data-testid={`palette-file-${file.path}`}
                      onSelect={() => choose(() => onOpenFile(file.path))}
                      title={file.path}
                    >
                      <FileText />
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <CommandShortcut className="max-w-[45%] truncate">{file.path}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
            {matchedCommands.length > 0 ? (
              <>
                {matchedSessions.length > 0 || matchedFiles.length > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading="Commands">
                  {matchedCommands.map((entry) => (
                    <CommandItem
                      key={entry.name}
                      value={`command:${entry.name}`}
                      data-testid={`palette-command-${entry.name}`}
                      onSelect={() => choose(entry.run)}
                    >
                      <Terminal />
                      <span className="flex-1 truncate">{entry.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
            {matchedActions.length > 0 ? (
              <>
                {matchedSessions.length > 0 || matchedFiles.length > 0 || matchedCommands.length > 0 ? (
                  <CommandSeparator />
                ) : null}
                <CommandGroup heading="Skills">
                  {matchedActions.map((entry) => (
                    <CommandItem
                      key={`${entry.kind}:${entry.source.kind}:${entry.name}`}
                      value={`${entry.kind}:${entry.source.kind}:${entry.name}`}
                      data-testid={`palette-action-${entry.name}`}
                      onSelect={() => choose(() => onInsert(entry.name))}
                      title={entry.description}
                    >
                      <Sparkles />
                      <span className="flex-1 truncate">/{entry.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
            {!hasResults ? <CommandEmpty data-testid="palette-empty">Nothing matches.</CommandEmpty> : null}
            {truncated && query.length > 0 ? (
              // Said out loud rather than swallowed: past the cap this list is
              // incomplete, and a file that is missing for that reason looks
              // exactly like a file that does not exist.
              <p data-testid="palette-truncated" className="px-3 py-2 text-xs text-muted-foreground">
                Showing part of a very large project.
              </p>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
