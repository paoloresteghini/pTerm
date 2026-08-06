import type { ProjectDescriptor, TabDescriptor } from '../shared/ipc'
import type { TabState } from '../shared/status'
import { StatusDot } from './StatusDot'
import { projectIdForTab } from './workspace'

/**
 * The global list of everything blocking a human, pinned above the project
 * tree. At twelve sessions across five customers this is the answer to the
 * question the app exists for, without expanding anything.
 *
 * Absent entirely when nothing needs you — an empty "Needs you" heading is a
 * thing to check, and the point is not having to.
 */
export function NeedsYou({
  tabs,
  projects,
  status,
  onSelect,
  onAcknowledge,
}: {
  tabs: TabDescriptor[]
  projects: ProjectDescriptor[]
  status: Record<string, TabState>
  onSelect: (tab: TabDescriptor) => void
  onAcknowledge: (tab: TabDescriptor) => void
}) {
  if (tabs.length === 0) return null
  return (
    <div data-testid="needs-you" className="border-b border-border pb-1">
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        <span>Needs you</span>
        <span data-testid="needs-you-count" className="text-amber-400">
          {tabs.length}
        </span>
      </div>
      {tabs.map((tab) => {
        const project = projects.find(
          (candidate) => candidate.id === projectIdForTab(projects, tab),
        )
        return (
          <div key={tab.id} className="flex w-full items-center">
            <button
              data-testid={`needs-${tab.id}`}
              onClick={() => onSelect(tab)}
              className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 border-none bg-transparent px-2.5 py-0.5 text-left text-muted hover:text-fg"
            >
              <StatusDot state={status[tab.id] ?? null} testid={`ndot-${tab.id}`} />
              <span className="truncate">
                {project?.name ?? 'Unsorted'} · {tab.id.slice(0, 6)}
              </span>
            </button>
            <button
              data-testid={`ack-${tab.id}`}
              aria-label="Mark actioned"
              title="Mark actioned"
              onClick={() => onAcknowledge(tab)}
              className="shrink-0 cursor-default border-none bg-transparent px-2 py-0.5 text-muted hover:text-fg"
            >
              ✓
            </button>
          </div>
        )
      })}
    </div>
  )
}
