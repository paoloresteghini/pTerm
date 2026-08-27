import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import type { ProjectDescriptor, SkillEntry } from '../shared/ipc'
import { filterEntries } from './lib/match'
import { useColumnWidth } from './lib/columnWidth'
import { cn } from './lib/cn'
import { ColumnResizer, PanelHeading, PanelStrip, PanelSurface, type PanelSide } from './ui/Panel'

/**
 * Was the top half of `RightPanel`, which owned Skills and Presets in one
 * column and collapsed only as a pair. They are two columns now: this one
 * toggles on its own item and `⌥⌘S`, independently of Presets.
 *
 * `collapsed` is a prop rather than this component's own state, the same
 * shape every other column (including `NotesPanel`) now takes: `App` is the
 * one place that has to answer to the View menu's six items and the
 * hide-all/restore pair, so it holds all six flags itself.
 */
export function SkillsPanel({
  project,
  onInsert,
  collapsed,
  onToggle,
  onDragStart,
  side,
  embedded = false,
}: {
  project: ProjectDescriptor | undefined
  onInsert: (name: string) => void
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  side: PanelSide
  /** Renders beneath Environment in Workspace Light instead of in the row. */
  embedded?: boolean
}) {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const { width, set, commit } = useColumnWidth('pterm:skillsWidth')
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
    window.pterm
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
    return (
      <PanelStrip
        testid="skills-toggle"
        label="Skills"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
        embedded={embedded}
      />
    )
  }

  return (
    <PanelSurface
      data-testid="skills-panel"
      embedded={embedded}
      side={side}
      // `relative` for the resizer, positioned off `side`.
      className={cn(
        'utility-panel utility-panel-skills font-mono text-[11px] select-none',
      )}
      style={embedded ? undefined : { width }}
    >
      <PanelHeading
        testid="skills-toggle"
        label="Skills"
        onClick={onToggle}
        onDragStart={onDragStart}
      />
      <Input
        data-testid="skills-filter"
        // Load-bearing, not decoration. Without it ⌘W typed while filtering
        // closes a pane and destroys its tmux session. This repo has paid for
        // that once already, during a project rename.
        data-shortcuts="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter skills"
        spellCheck={false}
        className="utility-filter mx-2.5 mb-1 border-border bg-transparent px-1.5 py-1 text-[11px] text-fg placeholder:text-faint"
      />
      {/* `scroll-`, not `skills-`: every prefix locator in the e2e suite is
          listed in `tests/e2e/`, and `[data-testid^="skill-"]` counts the rows
          in this very list. A testid called `skills-scroll` would be counted as
          a fifth skill by assertions that name four. */}
      <div data-testid="scroll-skills" className="utility-list scroll-thin min-h-0 flex-1 overflow-y-auto">
        {skills === null ? (
          <p data-testid="skills-loading" className="utility-empty px-2.5 py-1 text-faint">
            …
          </p>
        ) : matched.length === 0 ? (
          <p data-testid="skills-empty" className="utility-empty px-2.5 py-1 text-faint">
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
              className="utility-row flex w-full cursor-default items-baseline gap-2 border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
            >
              <span className="flex-1 truncate">{entry.name}</span>
              {/* A plugin's provenance is already in its name, so only a
                  project's own entries need a tag. Same rule as Presets. */}
              {entry.source.kind === 'repo' ? <span className="text-faint">repo</span> : null}
            </button>
          ))
        )}
      </div>
      {!embedded ? (
        <ColumnResizer
          testid="resize-skills"
          side={side}
          width={width}
          onResize={set}
          onCommit={commit}
        />
      ) : null}
    </PanelSurface>
  )
}
