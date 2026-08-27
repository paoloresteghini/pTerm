import type { ProjectDescriptor, TabType } from '../shared/ipc'
import { useColumnWidth } from './lib/columnWidth'
import { cn } from './lib/cn'
import { ColumnResizer, PanelHeading, PanelStrip, PanelSurface, type PanelSide } from './ui/Panel'

/**
 * Was the bottom half of `RightPanel`, sharing a column (and a collapse) with
 * Skills. Its own column now, so a workspace that declares one preset can give
 * the whole thing back to the terminal without losing the skills list too.
 *
 * Collapsed by default on a fresh profile (`App.tsx`): a second always-on
 * column must not take terminal width unasked, which is the rule `NotesPanel`
 * already follows.
 */
export function PresetsPanel({
  project,
  onRun,
  collapsed,
  onToggle,
  onDragStart,
  side,
  embedded = false,
}: {
  project: ProjectDescriptor | undefined
  onRun: (command: string, type: TabType) => void
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  side: PanelSide
  /** Renders beneath Environment in Workspace Light instead of in the row. */
  embedded?: boolean
}) {
  const { width, set, commit } = useColumnWidth('pterm:presetsWidth')

  if (collapsed) {
    return (
      <PanelStrip
        testid="presets-toggle"
        label="Presets"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
        embedded={embedded}
      />
    )
  }

  return (
    <PanelSurface
      data-testid="presets-panel"
      embedded={embedded}
      side={side}
      className={cn(
        'utility-panel utility-panel-presets select-none',
      )}
      style={embedded ? undefined : { width }}
    >
      <PanelHeading
        testid="presets-toggle"
        label="Presets"
        onClick={onToggle}
        onDragStart={onDragStart}
      />
      <div className="utility-list scroll-thin min-h-0 flex-1 overflow-y-auto">
        {/* Not `preset-claude`: a repository declaring a preset labelled
            `claude` would otherwise produce two elements with that testid. */}
        <button
          data-testid="preset-default-claude"
          disabled={!project || !project.available}
          onClick={() => onRun('claude', 'claude')}
          className="utility-row w-full cursor-default border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
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
            className="utility-row flex w-full cursor-default items-baseline gap-2 border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
          >
            <span className="flex-1 truncate">{preset.label}</span>
            {/* Provenance, so it is obvious which came from the repository. */}
            {preset.origin === 'repo' ? <span className="text-faint">repo</span> : null}
          </button>
        ))}
        {/* "declared": the `claude` button above is always there, so the panel
            is never actually empty. */}
        {project && project.presets.length === 0 ? (
          <p className="utility-empty px-2.5 py-1 text-faint">
            No declared presets. Add a .pterm.json to the repository.
          </p>
        ) : null}
      </div>
      {!embedded ? (
        <ColumnResizer
          testid="resize-presets"
          side={side}
          width={width}
          onResize={set}
          onCommit={commit}
        />
      ) : null}
    </PanelSurface>
  )
}
