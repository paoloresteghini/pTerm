import { useEffect, useState } from 'react'
import type { ProjectDescriptor, SkillEntry, TabType } from '../shared/ipc'
import { filterEntries } from './lib/match'

export function RightPanel({
  project,
  onRun,
  onInsert,
}: {
  project: ProjectDescriptor | undefined
  onRun: (command: string, type: TabType) => void
  onInsert: (name: string) => void
}) {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const cwd = project?.cwd

  // `App` renders this component only while the panel is open, so mounting is
  // the panel opening. Re-reading on open therefore falls out of this effect
  // rather than out of a cache anyone has to remember to invalidate. Keyed on
  // `cwd` so switching project re-reads too.
  useEffect(() => {
    if (!cwd) {
      setSkills([])
      return
    }
    let cancelled = false
    setSkills(null)
    window.prcli
      .skills(cwd)
      .then((found) => {
        if (!cancelled) setSkills(found)
      })
      .catch(() => {
        // The module behind this never throws, so a rejection here means the
        // IPC round trip itself failed. An empty section is the honest render:
        // this panel is not where a transport fault gets reported.
        if (!cancelled) setSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const matched = filterEntries(query, skills ?? [])

  return (
    <div
      data-testid="rightpanel"
      className="flex w-52 shrink-0 flex-col border-l border-border bg-surface font-mono text-[11px] select-none"
    >
      <div className="px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        Skills
      </div>
      <input
        data-testid="skills-filter"
        // Load-bearing, not decoration. Without it ⌘W typed while filtering
        // closes a pane and destroys its tmux session. This repo has paid for
        // that once already, during a project rename.
        data-shortcuts="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter skills"
        spellCheck={false}
        className="mx-2.5 mb-1 border border-border bg-transparent px-1.5 py-1 text-[11px] text-fg placeholder:text-faint focus:outline-none"
      />
      <div className="min-h-0 flex-[2] overflow-y-auto">
        {skills === null ? (
          <p data-testid="skills-loading" className="px-2.5 py-1 text-faint">
            …
          </p>
        ) : matched.length === 0 ? (
          <p data-testid="skills-empty" className="px-2.5 py-1 text-faint">
            {skills.length === 0 ? 'No skills found.' : 'Nothing matches.'}
          </p>
        ) : (
          matched.map((entry) => (
            // Keyed on source and kind as well as name. Name alone is unique
            // across today's entries, but nothing makes it so: a skill
            // directory `foo/` and a command `foo.md` both yield `foo`.
            <button
              key={`${entry.kind}:${entry.source.kind}:${entry.name}`}
              data-testid={`skill-${entry.name}`}
              disabled={!project?.available}
              onClick={() => onInsert(entry.name)}
              title={entry.description}
              className="flex w-full cursor-default items-baseline gap-2 border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
            >
              <span className="flex-1 truncate">{entry.name}</span>
              {/* A plugin's provenance is already in its name, so only a
                  project's own entries need a tag. Same rule as Presets. */}
              {entry.source.kind === 'repo' ? <span className="text-faint">repo</span> : null}
            </button>
          ))
        )}
      </div>

      <div className="px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        Presets
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Not `preset-claude`: a repository declaring a preset labelled
            `claude` would otherwise produce two elements with that testid. */}
        <button
          data-testid="preset-default-claude"
          disabled={!project || !project.available}
          onClick={() => onRun('claude', 'claude')}
          className="w-full cursor-default border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
        >
          claude
        </button>
        {(project?.presets ?? []).map((preset) => (
          <button
            key={preset.id}
            data-testid={`preset-${preset.label}`}
            disabled={!project?.available}
            onClick={() => onRun(preset.command, 'preset')}
            title={preset.command}
            className="flex w-full cursor-default items-baseline gap-2 border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
          >
            <span className="flex-1 truncate">{preset.label}</span>
            {/* Provenance, so it is obvious which came from the repository. */}
            {preset.origin === 'repo' ? <span className="text-faint">repo</span> : null}
          </button>
        ))}
        {/* "declared": the `claude` button above is always there, so the panel
            is never actually empty. */}
        {project && project.presets.length === 0 ? (
          <p className="px-2.5 py-1 text-faint">
            No declared presets. Add a .prcli.json to the repository.
          </p>
        ) : null}
      </div>
    </div>
  )
}
