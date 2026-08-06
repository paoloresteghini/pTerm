import { useEffect, useState } from 'react'
import type { ProjectDescriptor, SkillEntry } from '../shared/ipc'
import { filterEntries } from './lib/match'
import { useColumnWidth } from './lib/columnWidth'
import { ColumnResizer, PanelHeading, PanelStrip } from './ui/Panel'

/**
 * Was the top half of `RightPanel`, which owned Skills and Presets in one
 * column and collapsed only as a pair. They are two columns now so either can
 * be given up for terminal width on its own.
 *
 * `collapsed` is a prop rather than this component's own state, unlike
 * `NotesPanel`: ⇧\ collapses this column and the presets column together, and
 * a keystroke in `App` cannot reach state that lives down here.
 */
export function SkillsPanel({
  project,
  onInsert,
  collapsed,
  onToggle,
}: {
  project: ProjectDescriptor | undefined
  onInsert: (name: string) => void
  collapsed: boolean
  onToggle: () => void
}) {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const { width, set, commit } = useColumnWidth('prcli:skillsWidth')
  const cwd = project?.cwd

  // Keyed on `cwd`, so switching project re-reads. Also re-reads when the
  // column is expanded, because collapsing unmounts this component entirely
  // and expanding mounts a fresh one: the read falls out of that rather than
  // out of a cache anyone has to remember to invalidate.
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

  if (collapsed) {
    return <PanelStrip testid="skills-toggle" label="Skills" onClick={onToggle} />
  }

  return (
    <div
      data-testid="skills-panel"
      // `relative` for the resizer over this column's left border.
      className="relative flex shrink-0 flex-col border-l border-border bg-surface font-mono text-[11px] select-none"
      style={{ width }}
    >
      <PanelHeading testid="skills-toggle" label="Skills" onClick={onToggle} />
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
      {/* `scroll-`, not `skills-`: every prefix locator in the e2e suite is
          listed in `tests/e2e/`, and `[data-testid^="skill-"]` counts the rows
          in this very list. A testid called `skills-scroll` would be counted as
          a fifth skill by assertions that name four. */}
      <div data-testid="scroll-skills" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {skills === null ? (
          <p data-testid="skills-loading" className="px-2.5 py-1 text-faint">
            …
          </p>
        ) : matched.length === 0 ? (
          <p data-testid="skills-empty" className="px-2.5 py-1 text-faint">
            {!project ? 'No project selected.' : skills.length === 0 ? 'No skills found.' : 'Nothing matches.'}
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
      <ColumnResizer
        testid="resize-skills"
        side="right"
        width={width}
        onResize={set}
        onCommit={commit}
      />
    </div>
  )
}
