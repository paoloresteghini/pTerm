import type { ProjectDescriptor, TabDescriptor } from '../shared/ipc'
import type { TabState } from '../shared/status'
import { StatusDot } from './StatusDot'
import { projectIdForTab } from './workspace'
import {
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

/**
 * The global list of everything blocking a human, pinned above the project
 * tree. At twelve sessions across five customers this is the answer to the
 * question the app exists for, without expanding anything.
 *
 * Absent entirely when nothing needs you — an empty "Needs you" heading is a
 * thing to check, and the point is not having to.
 *
 * Drawn with the same sidebar primitives as the project tree below, rather
 * than sizes of its own: it sat a size larger than every row under it and its
 * heading a size smaller than "Projects", which read as a different component
 * bolted above the list instead of the top of one list.
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
    <div data-testid="needs-you" className="border-b border-sidebar-border pb-2">
      <SidebarGroupLabel>
        <span>Needs you</span>
        <span data-testid="needs-you-count" className="ml-1.5 text-amber-400">
          {tabs.length}
        </span>
      </SidebarGroupLabel>
      <SidebarMenu>
        {tabs.map((tab) => {
          const project = projects.find(
            (candidate) => candidate.id === projectIdForTab(projects, tab),
          )
          return (
            <SidebarMenuItem key={tab.id}>
              <SidebarMenuButton
                type="button"
                data-testid={`needs-${tab.id}`}
                // Going to look at the prompt is the acknowledgement. The row
                // used to only jump, leaving the tick as the one way off the
                // list, so a tab you had read and answered stayed on the board
                // until you came back and cleared it by hand.
                onClick={() => {
                  onSelect(tab)
                  onAcknowledge(tab)
                }}
                className="cursor-default"
              >
                <StatusDot state={status[tab.id] ?? null} testid={`ndot-${tab.id}`} />
                <span className="min-w-0 truncate">{project?.name ?? 'Unsorted'}</span>
                <span className="shrink-0">· {tab.id.slice(0, 6)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </div>
  )
}
