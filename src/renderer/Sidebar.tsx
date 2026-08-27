import { useRef, useState, type CSSProperties, type ReactElement } from 'react'
import {
  UNSORTED_ID,
  canHaveSession,
  type ProjectDescriptor,
  type TabDescriptor,
  type TabState,
} from '../shared/ipc'
import { NeedsYou } from './NeedsYou'
import { StatusDot } from './StatusDot'
import { tabLabel } from './lib/tabLabel'
import { useColumnWidth } from './lib/columnWidth'
import { ColumnResizer, type PanelSide } from './ui/Panel'
import {
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  ChevronRight,
  FolderGit2,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import logo from '../images/logo.png'
import { Kbd } from '@/components/ui/kbd'
import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const MAX_VISIBLE_INACTIVE_PROJECTS = 5

export function Sidebar({
  projects,
  activeProjectId,
  tabsOf,
  activeTabId,
  status,
  projectStateOf,
  needsYou,
  onSelectNeedy,
  onAcknowledgeNeedy,
  muted,
  onToggleMute,
  onSelectProject,
  onSelectTab,
  onRename,
  onRenameTab,
  onMove,
  onRemove,
  onMoveTab,
  onCloseTab,
  inWall,
  onAddToWall,
  onRemoveFromWall,
  onAdd,
  onOpenSettings,
  side,
}: {
  projects: ProjectDescriptor[]
  activeProjectId: string | null
  tabsOf: (projectId: string) => TabDescriptor[]
  activeTabId: string | null
  status: Record<string, TabState>
  projectStateOf: (projectId: string) => TabState | null
  needsYou: TabDescriptor[]
  onSelectNeedy: (tab: TabDescriptor) => void
  onAcknowledgeNeedy: (tab: TabDescriptor) => void
  muted: (projectId: string) => boolean
  onToggleMute: (projectId: string) => void
  onSelectProject: (id: string) => void
  onSelectTab: (id: string) => void
  onRename: (id: string, name: string) => void
  onRenameTab: (id: string, title: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onRemove: (id: string) => void
  onMoveTab: (tabId: string, projectId: string) => void
  onCloseTab: (tabId: string) => void
  /** Whether this project holds a slot on the wall. */
  inWall: (id: string) => boolean
  onAddToWall: (id: string) => void
  onRemoveFromWall: (id: string) => void
  onAdd: () => void
  onOpenSettings: () => void
  /** Always `'left'` in practice: `App.tsx`'s `moveColumn` refuses to move
   *  `projects`, so unlike every other column this one never has a `side`
   *  to derive from `columnOrder`. A prop instead of a literal here anyway,
   *  for the same shape the other seven columns take. */
  side: PanelSide
}) {
  // Resizable like every other column, though this one never collapses:
  // it is the only way to reach a project, and a workspace with no visible
  // project list is a window with nothing to do.
  const { width, set, commit } = useColumnWidth('pterm:sidebarWidth', 256)
  const [inactiveDialogOpen, setInactiveDialogOpen] = useState(false)
  // Renaming happens in the row itself. `window.prompt` is not implemented in
  // Electron — it *throws* ("prompt() is not supported."), so the rename it
  // used to guard never fired at all — and an inline edit suits a
  // keyboard-driven app better than a modal.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [tabDraft, setTabDraft] = useState('')
  // Which edit is still open, readable synchronously so that whichever of the
  // two commit paths arrives second is a no-op. Enter and Escape both unmount
  // the input, which today's Chromium does not follow with a blur — but the
  // handlers must not depend on that to avoid committing twice, or committing
  // what Escape discarded.
  const editing = useRef<string | null>(null)
  const tabEditing = useRef<string | null>(null)

  /** A project plus its position in `projects`, so move controls and keyboard
   *  shortcuts continue to resolve against the stored order. */
  type Row = { project: ProjectDescriptor; index: number; tabs: TabDescriptor[] }

  const startRename = (project: ProjectDescriptor): void => {
    editing.current = project.id
    setDraft(project.name)
    setRenamingId(project.id)
  }

  const finishRename = (id: string, commit: boolean): void => {
    if (editing.current !== id) return
    editing.current = null
    setRenamingId(null)
    const name = draft.trim()
    if (commit && name) onRename(id, name)
  }

  const startRenameTab = (tab: TabDescriptor): void => {
    tabEditing.current = tab.id
    setTabDraft(tab.title ?? '')
    setRenamingTabId(tab.id)
  }

  const finishRenameTab = (id: string, commit: boolean): void => {
    if (tabEditing.current !== id) return
    tabEditing.current = null
    setRenamingTabId(null)
    if (commit) onRenameTab(id, tabDraft.trim())
  }

  // Grouped, not sorted: the projects you have sessions open in sit together at
  // the top, the dormant ones in a section of their own pinned above the
  // footer. Within each group the manual order from "Move up"/"Move down" is
  // untouched, so the list a user arranged is still the list they get.
  const rows: Row[] = projects.map((project, index) => ({
    project,
    index,
    tabs: tabsOf(project.id),
  }))
  const live = rows.filter((row) => row.tabs.length > 0)
  const dormant = rows.filter((row) => row.tabs.length === 0)
  const orderedRows = [...live, ...dormant]
  // The Inactive section only earns its place when there is something on both
  // sides of it: a heading over the whole list would be labelling nothing, and
  // a list anchored to the footer with an empty scroll area above it would be
  // the entire sidebar hanging off the bottom of the window. When it is not
  // split, every row goes in the scroll area in the usual order.
  const split = live.length > 0 && dormant.length > 0

  /** One project row, its open tabs, and its menu. A function rather than an
   *  inline map body, because the scroll area and the pinned Inactive section
   *  below both draw it. */
  const projectRow = ({ project, index, tabs }: Row, onSelected?: () => void): ReactElement => {
    const active = project.id === activeProjectId
    const synthetic = project.id === UNSORTED_ID
    const isMuted = muted(project.id)
    const shortcut = index < 9 ? `⌘${index + 1}` : null
    // A live project is still useful to spot before its first status event
    // arrives. Give it the same quiet idle marker older project rows used;
    // a reported state always takes precedence, and dormant projects stay
    // unmarked.
    const projectState = projectStateOf(project.id) ?? (tabs.length > 0 ? 'idle' : null)
    return (
      <SidebarMenuItem key={project.id}>
        <SidebarMenuButton
          asChild
          data-testid={`project-${project.id}`}
          isActive={active}
          className="cursor-default"
        >
          <div
            data-testid={`project-${project.id}`}
            onClick={() => {
              onSelectProject(project.id)
              onSelected?.()
            }}
          >
            <FolderGit2 aria-hidden />
            <StatusDot state={projectState} testid={`pdot-${project.id}`} />
            {renamingId === project.id ? (
              <input
                data-testid={`rename-input-${project.id}`}
                // The window-level ⌘ handler skips anything inside this,
                // so ⌘W typed mid-rename edits the text instead of closing
                // a tab and destroying its session. See App.tsx's keydown.
                data-shortcuts="off"
                aria-label={`Rename ${project.name}`}
                autoFocus
                // Selected, not just focused: the draft is seeded with the
                // current name, and a rename is usually a replacement.
                onFocus={(event) => event.target.select()}
                value={draft}
                // Without this, typing in the row also selects the project.
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => finishRename(project.id, true)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') finishRename(project.id, true)
                  if (event.key === 'Escape') finishRename(project.id, false)
                }}
                className="min-w-0 flex-1 rounded-sm border border-sidebar-border bg-background px-1 text-sidebar-foreground outline-none"
              />
            ) : (
              <span className="flex-1 truncate">{project.name}</span>
            )}
            {!project.available ? (
              <span title={`${project.cwd} is missing`} className="text-danger">
                !
              </span>
            ) : null}
            {shortcut ? (
              <SidebarMenuBadge className={synthetic ? undefined : 'right-7'}>
                <Kbd title={`Select ${project.name} with ${shortcut}`} className="text-[11px] text-inherit">
                  {shortcut}
                </Kbd>
              </SidebarMenuBadge>
            ) : null}
            {!synthetic ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction
                    type="button"
                    data-testid={`pmenu-${project.id}`}
                    aria-label={`Actions for ${project.name}`}
                    onClick={(event) => event.stopPropagation()}
                    showOnHover
                    className="right-1 cursor-default"
                  >
                    <MoreHorizontal />
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  side="bottom"
                  className="w-52"
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <DropdownMenuItem
                    data-testid={`prename-${project.id}`}
                    onSelect={() => startRename(project)}
                  >
                    <Pencil />
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid={`pup-${project.id}`}
                    disabled={index === 0}
                    onSelect={() => onMove(project.id, -1)}
                  >
                    <ArrowUp />
                    Move up
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid={`pdown-${project.id}`}
                    onSelect={() => onMove(project.id, 1)}
                  >
                    <ArrowDown />
                    Move down
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid={`pmute-${project.id}`}
                    onSelect={() => onToggleMute(project.id)}
                  >
                    {isMuted ? <Bell /> : <BellOff />}
                    {isMuted ? 'Unmute project' : 'Mute project'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid={`pwall-${project.id}`}
                    onSelect={() => onAddToWall(project.id)}
                  >
                    <LayoutGrid />
                    Add to wall
                  </DropdownMenuItem>
                  {inWall(project.id) ? (
                    <DropdownMenuItem
                      data-testid={`pwall-remove-${project.id}`}
                      onSelect={() => onRemoveFromWall(project.id)}
                    >
                      <LayoutGrid />
                      Remove all wall cells
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid={`premove-${project.id}`}
                    variant="destructive"
                    onSelect={() => onRemove(project.id)}
                  >
                    <Trash2 />
                    Remove project
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </SidebarMenuButton>

        {tabs.length > 0 ? (
          <SidebarMenuSub className="ml-6 mr-2 mt-0.5">
            {tabs.map((tab) => (
              <SidebarMenuSubItem key={tab.id}>
                <SidebarMenuSubButton
                  asChild
                  isActive={tab.id === activeTabId}
                  className="h-7 cursor-default px-2 text-[13px]"
                >
                  <div
                    data-testid={`stab-${tab.id}`}
                    onClick={() => {
                      onSelectProject(project.id)
                      onSelectTab(tab.id)
                    }}
                  >
                    <StatusDot
                      state={status[tab.id] ?? (canHaveSession(tab) ? 'idle' : null)}
                      testid={`sdot-${tab.id}`}
                    />
                    {renamingTabId === tab.id ? (
                      <input
                        autoFocus
                        data-testid={`stabinput-${tab.id}`}
                        value={tabDraft}
                        aria-label={`Rename ${tabLabel(tab)}`}
                        onChange={(event) => setTabDraft(event.target.value)}
                        onBlur={() => finishRenameTab(tab.id, true)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') finishRenameTab(tab.id, true)
                          if (event.key === 'Escape') finishRenameTab(tab.id, false)
                        }}
                        onClick={(event) => event.stopPropagation()}
                        className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-sidebar-foreground outline-none"
                      />
                    ) : (
                      <span
                        onDoubleClick={(event) => {
                          event.stopPropagation()
                          startRenameTab(tab)
                        }}
                        className="min-w-0 flex-1 truncate"
                      >
                        {tabLabel(tab)}
                      </span>
                    )}
                    {synthetic && canHaveSession(tab) ? (
                      <>
                        <select
                          data-testid={`smove-${tab.id}`}
                          aria-label={`Move ${tab.id.slice(0, 6)} to a project`}
                          value=""
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            if (event.target.value) onMoveTab(tab.id, event.target.value)
                          }}
                          className="cursor-default rounded-sm border border-sidebar-border bg-background px-1 text-xs text-sidebar-foreground/70"
                        >
                          <option value="">move…</option>
                          {projects
                            .filter((candidate) => candidate.id !== UNSORTED_ID)
                            .map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.name}
                              </option>
                            ))}
                        </select>
                        <button
                          type="button"
                          data-testid={`sclose-${tab.id}`}
                          aria-label={`Close ${tabLabel(tab)}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            onCloseTab(tab.id)
                          }}
                          className="shrink-0 rounded-sm p-0.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        >
                          <X className="size-3.5" />
                        </button>
                      </>
                    ) : null}
                  </div>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        ) : null}
      </SidebarMenuItem>
    )
  }

  const visibleDormant = dormant.slice(0, MAX_VISIBLE_INACTIVE_PROJECTS)
  const hiddenDormantCount = dormant.length - visibleDormant.length
  const projectRows = split ? live : orderedRows.slice(0, live.length + MAX_VISIBLE_INACTIVE_PROJECTS)
  const moreInactiveProjects =
    hiddenDormantCount > 0 ? (
      <SidebarMenuItem>
        <SidebarMenuButton
          type="button"
          data-testid="show-more-inactive-projects"
          onClick={() => setInactiveDialogOpen(true)}
          className="cursor-default text-sidebar-foreground/70"
        >
          <span className="flex-1">Show {hiddenDormantCount} more</span>
          <ChevronRight aria-hidden />
        </SidebarMenuButton>
      </SidebarMenuItem>
    ) : null

  return (
    <SidebarProvider
      className="contents"
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
    >
      <ShadcnSidebar
        side="left"
        collapsible="none"
        data-testid="sidebar"
        className="relative shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none"
        style={{ width }}
      >
        <SidebarHeader className="gap-2 p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" className="cursor-default">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-[#3f3f46]">
                  <img src={logo} alt="" className="h-5 w-5 object-contain" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">pTerm</span>
                  <span className="truncate text-xs text-sidebar-foreground/60">Project workspace</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <NeedsYou
            tabs={needsYou}
            projects={projects}
            status={status}
            onSelect={onSelectNeedy}
            onAcknowledge={onAcknowledgeNeedy}
          />

        </SidebarHeader>

        <SidebarContent className="gap-0">
          <SidebarGroup className="flex-1 px-2 py-0">
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {projectRows.map((row) => projectRow(row))}
                {!split ? moreInactiveProjects : null}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {split ? (
          <SidebarGroup className="shrink-0 border-t border-sidebar-border px-2 py-2">
            <SidebarGroupLabel
              data-testid="inactive-heading"
            >
              Inactive
            </SidebarGroupLabel>
            <SidebarGroupContent className="max-h-[40vh] overflow-y-auto">
              <SidebarMenu>
                {visibleDormant.map((row) => projectRow(row))}
                {moreInactiveProjects}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          ) : null}
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border p-2">
          <SidebarMenu className="gap-1">
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                data-testid="add-project"
                onClick={onAdd}
                className="cursor-default"
              >
                <Plus />
                <span>Add project</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                data-testid="settings-open"
                onClick={onOpenSettings}
                className="cursor-default"
              >
                <Settings />
                <span>Settings…</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <ColumnResizer
          testid="resize-sidebar"
          side={side}
          width={width}
          onResize={set}
          onCommit={commit}
        />
      </ShadcnSidebar>
      <Dialog open={inactiveDialogOpen} onOpenChange={setInactiveDialogOpen}>
        <DialogContent data-testid="inactive-projects-dialog" className="max-w-md gap-0 p-0 font-sans">
          <DialogHeader className="border-b border-border px-5 py-4 pr-12">
            <DialogTitle>Inactive projects</DialogTitle>
            <DialogDescription>
              Choose a project to make it active.
            </DialogDescription>
          </DialogHeader>
          <div className="scroll-thin max-h-[60vh] overflow-y-auto p-2">
            <SidebarMenu>{dormant.map((row) => projectRow(row, () => setInactiveDialogOpen(false)))}</SidebarMenu>
          </div>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  )
}
