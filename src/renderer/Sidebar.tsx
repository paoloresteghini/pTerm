import { useRef, useState } from 'react'
import { UNSORTED_ID, type ProjectDescriptor, type TabDescriptor } from '../shared/ipc'
import { cn } from './lib/cn'
import { Button } from './ui/Button'

export function Sidebar({
  projects,
  activeProjectId,
  tabsOf,
  activeTabId,
  onSelectProject,
  onSelectTab,
  onRename,
  onMove,
  onRemove,
  onMoveTab,
  onAdd,
}: {
  projects: ProjectDescriptor[]
  activeProjectId: string | null
  tabsOf: (projectId: string) => TabDescriptor[]
  activeTabId: string | null
  onSelectProject: (id: string) => void
  onSelectTab: (id: string) => void
  onRename: (id: string, name: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onRemove: (id: string) => void
  onMoveTab: (tabId: string, projectId: string) => void
  onAdd: () => void
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
      <div className="px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        Projects
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {projects.map((project, index) => {
          const active = project.id === activeProjectId
          const synthetic = project.id === UNSORTED_ID
          const tabs = tabsOf(project.id)
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
                {renamingId === project.id ? (
                  <input
                    data-testid={`rename-input-${project.id}`}
                    aria-label={`Rename ${project.name}`}
                    autoFocus
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
                      <div
                        data-testid={`stab-${tab.id}`}
                        onClick={() => onSelectTab(tab.id)}
                        className={cn(
                          'flex-1 cursor-default truncate py-0.5',
                          tab.id === activeTabId ? 'text-fg' : 'text-muted hover:text-fg',
                        )}
                      >
                        {tab.projectSlug} · {tab.id.slice(0, 6)}
                      </div>
                      {/* Rehoming: a stray must be filable, or Unsorted is a
                          place things can be seen but never leave. Renaming
                          its tmux session is what actually moves it. */}
                      {synthetic ? (
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

      <div className="border-t border-border p-2">
        <Button data-testid="add-project" variant="ghost" onClick={onAdd} className="w-full">
          + Add project
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
