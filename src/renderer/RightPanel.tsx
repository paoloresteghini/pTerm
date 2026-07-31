import type { ProjectDescriptor, TabType } from '../shared/ipc'

export function RightPanel({
  project,
  onRun,
}: {
  project: ProjectDescriptor | undefined
  onRun: (command: string, type: TabType) => void
}) {
  return (
    <div
      data-testid="rightpanel"
      className="flex w-52 shrink-0 flex-col border-l border-border bg-surface font-mono text-[11px] select-none"
    >
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
