import { useRef, useState } from 'react'
import {
  UNSORTED_ID,
  canHaveSession,
  type ProjectDescriptor,
  type TabDescriptor,
  type TabState,
} from '../shared/ipc'
import { cn } from './lib/cn'
import { Button } from './ui/Button'
import { NeedsYou } from './NeedsYou'
import { StatusDot } from './StatusDot'
import { tabLabel } from './lib/tabLabel'
import { FileTree } from './FileTree'

export function Sidebar({
  projects,
  activeProjectId,
  tabsOf,
  activeTabId,
  status,
  projectStateOf,
  needsYou,
  onSelectNeedy,
  muted,
  onToggleMute,
  onSelectProject,
  onSelectTab,
  onOpenFile,
  onRename,
  onMove,
  onRemove,
  onMoveTab,
  onAdd,
  onOpenSettings,
}: {
  projects: ProjectDescriptor[]
  activeProjectId: string | null
  tabsOf: (projectId: string) => TabDescriptor[]
  activeTabId: string | null
  status: Record<string, TabState>
  projectStateOf: (projectId: string) => TabState | null
  needsYou: TabDescriptor[]
  onSelectNeedy: (tab: TabDescriptor) => void
  muted: (projectId: string) => boolean
  onToggleMute: (projectId: string) => void
  onSelectProject: (id: string) => void
  onSelectTab: (id: string) => void
  /** A file row clicked in the tree, by its path relative to the project. */
  onOpenFile: (relPath: string) => void
  onRename: (id: string, name: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onRemove: (id: string) => void
  onMoveTab: (tabId: string, projectId: string) => void
  onAdd: () => void
  onOpenSettings: () => void
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null)
  // Renaming happens in the row itself. `window.prompt` is not implemented in
  // Electron — it *throws* ("prompt() is not supported."), so the rename it
  // used to guard never fired at all — and an inline edit suits a
  // keyboard-driven app better than a modal.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Which edit is still open, readable synchronously so that whichever of the
  // two commit paths arrives second is a no-op. Enter and Escape both unmount
  // the input, which today's Chromium does not follow with a blur — but the
  // handlers must not depend on that to avoid committing twice, or committing
  // what Escape discarded.
  const editing = useRef<string | null>(null)

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

  return (
    <div
      data-testid="sidebar"
      className="flex w-52 shrink-0 flex-col border-r border-border bg-surface font-mono text-[11px] select-none"
    >
      <NeedsYou tabs={needsYou} projects={projects} status={status} onSelect={onSelectNeedy} />

      <div className="px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        Projects
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {projects.map((project, index) => {
          const active = project.id === activeProjectId
          const synthetic = project.id === UNSORTED_ID
          const tabs = tabsOf(project.id)
          const isMuted = muted(project.id)
          return (
            <div key={project.id}>
              <div
                data-testid={`project-${project.id}`}
                data-active={active ? 'true' : 'false'}
                onClick={() => onSelectProject(project.id)}
                className={cn(
                  'group flex cursor-default items-center gap-1.5 px-2.5 py-1',
                  active ? 'bg-bg text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {/* ⌘1–9 follows sidebar order, so the number is the shortcut. */}
                <span className="w-3 text-faint">{index < 9 ? index + 1 : ''}</span>
                <StatusDot state={projectStateOf(project.id)} testid={`pdot-${project.id}`} />
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
                    className="min-w-0 flex-1 border border-border bg-bg px-1 text-fg outline-none"
                  />
                ) : (
                  <span className="flex-1 truncate">{project.name}</span>
                )}
                {!project.available ? (
                  <span title={`${project.cwd} is missing`} className="text-danger">
                    !
                  </span>
                ) : null}
                <span className="text-faint">{tabs.length || ''}</span>
                {synthetic ? null : (
                  <button
                    data-testid={`pmenu-${project.id}`}
                    aria-label={`Actions for ${project.name}`}
                    onClick={(event) => {
                      // Without this the click also selects the project.
                      event.stopPropagation()
                      setMenuFor((current) => (current === project.id ? null : project.id))
                    }}
                    className="cursor-default border-none bg-transparent px-0.5 text-faint hover:text-fg"
                  >
                    ⋯
                  </button>
                )}
              </div>

              {menuFor === project.id ? (
                <div className="flex flex-col border-y border-border bg-bg py-0.5">
                  <MenuItem
                    testid={`prename-${project.id}`}
                    label="Rename…"
                    onClick={() => {
                      setMenuFor(null)
                      startRename(project)
                    }}
                  />
                  <MenuItem
                    testid={`pup-${project.id}`}
                    label="Move up"
                    disabled={index === 0}
                    onClick={() => {
                      setMenuFor(null)
                      onMove(project.id, -1)
                    }}
                  />
                  <MenuItem
                    testid={`pdown-${project.id}`}
                    label="Move down"
                    onClick={() => {
                      setMenuFor(null)
                      onMove(project.id, 1)
                    }}
                  />
                  <MenuItem
                    testid={`pmute-${project.id}`}
                    label={isMuted ? 'Unmute project' : 'Mute project'}
                    onClick={() => {
                      setMenuFor(null)
                      onToggleMute(project.id)
                    }}
                  />
                  <MenuItem
                    testid={`premove-${project.id}`}
                    label="Remove project"
                    onClick={() => {
                      setMenuFor(null)
                      onRemove(project.id)
                    }}
                  />
                </div>
              ) : null}

              {active
                ? tabs.map((tab) => (
                    <div key={tab.id} className="flex items-center gap-1 pl-8 pr-2.5">
                      <StatusDot state={status[tab.id] ?? null} testid={`sdot-${tab.id}`} />
                      <div
                        data-testid={`stab-${tab.id}`}
                        onClick={() => onSelectTab(tab.id)}
                        className={cn(
                          'flex-1 cursor-default truncate py-0.5',
                          tab.id === activeTabId ? 'text-fg' : 'text-muted hover:text-fg',
                        )}
                      >
                        {tabLabel(tab)}
                      </div>
                      {/* Rehoming: a stray must be filable, or Unsorted is a
                          place things can be seen but never leave. Renaming
                          its tmux session is what actually moves it.

                          Which is exactly why a sessionless pane is not
                          offered it. `manager.moveTabToProject` resolves the
                          tab through `panesOfTab`, which reads live tmux, and
                          an editor tab has nothing there: it threw
                          `moveTabToProject: no session for tab <id>` and
                          `fail` painted that string into `startup-error`.
                          Rehoming one is not merely unimplemented, it has no
                          good answer in B1 either. An editor pane's project
                          membership is `PaneRecord.projectSlug` on disk rather
                          than a tmux name, so the rename has nothing to do,
                          but its `filePath` is ABSOLUTE inside the project it
                          came from, so a move that "worked" would leave the
                          pane reporting that its file is gone. A move that
                          succeeds and then breaks the pane is worse than no
                          move, so the affordance is withheld rather than the
                          error being made prettier. */}
                      {synthetic && canHaveSession(tab) ? (
                        <select
                          data-testid={`smove-${tab.id}`}
                          aria-label={`Move ${tab.id.slice(0, 6)} to a project`}
                          value=""
                          onChange={(event) => {
                            if (event.target.value) onMoveTab(tab.id, event.target.value)
                          }}
                          className="cursor-default border border-border bg-bg text-[10px] text-muted"
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
                      ) : null}
                    </div>
                  ))
                : null}
            </div>
          )
        })}
      </div>

      <FileTree projectId={activeProjectId ?? undefined} onOpenFile={onOpenFile} />

      <div className="flex flex-col gap-1 border-t border-border p-2">
        <Button data-testid="add-project" variant="ghost" onClick={onAdd} className="w-full">
          + Add project
        </Button>
        <Button
          data-testid="settings-open"
          variant="ghost"
          onClick={onOpenSettings}
          className="w-full"
        >
          Settings…
        </Button>
      </div>
    </div>
  )
}

function MenuItem({
  testid,
  label,
  onClick,
  disabled,
}: {
  testid: string
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      className="cursor-default border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
    >
      {label}
    </button>
  )
}
